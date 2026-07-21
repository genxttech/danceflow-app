"use client";

import { useRef, useState } from "react";
import { ImageIcon, Loader2, Trash2, UploadCloud } from "lucide-react";
import {
  removeDigitalCoverImageAction,
  saveDigitalCoverImageAction,
} from "./actions";

export default function DigitalCoverImageForm({
  catalogItemId,
  currentImageUrl,
  resolvedImageUrl,
  resolvedSource,
}: {
  catalogItemId: string;
  currentImageUrl: string | null;
  resolvedImageUrl: string | null;
  resolvedSource: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [submitting, setSubmitting] = useState(false);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <div className="aspect-video w-full overflow-hidden rounded-2xl border border-slate-200 bg-[linear-gradient(135deg,#ede9fe,#fdf2f8)] lg:max-w-md">
          {resolvedImageUrl ? (
            <img
              src={resolvedImageUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full min-h-56 items-center justify-center">
              <ImageIcon className="h-12 w-12 text-violet-400" />
            </div>
          )}
        </div>

        <div className="flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
            Discovery cover
          </p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">
            Video thumbnail
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            DanceFlow uses a Mux frame automatically. Upload a custom cover only
            when you want to override it. Removing the custom cover restores the
            Mux thumbnail immediately.
          </p>
          <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600">
            Current source:{" "}
            {resolvedSource === "custom"
              ? "Custom cover"
              : resolvedSource.includes("mux")
                ? "Mux automatic thumbnail"
                : "DanceFlow fallback"}
          </p>

          <form
            action={saveDigitalCoverImageAction}
            className="mt-5"
            onSubmit={() => setSubmitting(true)}
          >
            <input type="hidden" name="catalogItemId" value={catalogItemId} />
            <input
              ref={inputRef}
              name="coverImage"
              type="file"
              required
              accept="image/jpeg,image/png,image/webp"
              className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
            />
            <p className="mt-2 text-xs text-slate-500">
              JPG, PNG, or WebP · up to 5 MB · 16:9 recommended.
            </p>
            <button
              disabled={submitting}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="h-4 w-4" />
              )}
              {submitting ? "Uploading…" : "Upload custom cover"}
            </button>
          </form>

          {currentImageUrl ? (
            <form action={removeDigitalCoverImageAction} className="mt-3">
              <input type="hidden" name="catalogItemId" value={catalogItemId} />
              <button className="inline-flex items-center gap-2 rounded-xl border border-rose-200 px-4 py-2.5 text-sm font-semibold text-rose-700 hover:bg-rose-50">
                <Trash2 className="h-4 w-4" />
                Remove custom cover
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </section>
  );
}

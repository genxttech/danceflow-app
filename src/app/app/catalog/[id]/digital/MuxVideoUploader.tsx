"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  FileVideo,
  Loader2,
  RefreshCcw,
  UploadCloud,
  XCircle,
} from "lucide-react";

const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const ACCEPTED_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-m4v",
  "video/webm",
];

type UploadState =
  | "idle"
  | "preparing"
  | "uploading"
  | "processing"
  | "failed";

export default function MuxVideoUploader({
  catalogItemId,
  muxStatus,
  errorMessage,
}: {
  catalogItemId: string;
  muxStatus: string | null;
  errorMessage: string | null;
}) {
  const router = useRouter();
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const processing = ["asset_created", "processing"].includes(
    muxStatus ?? "",
  );
  const interruptedServerUpload = ["waiting", "uploading"].includes(
    muxStatus ?? "",
  );


  useEffect(() => {
    if (muxStatus === "ready") {
      setState("idle");
      setProgress(100);
      setFile(null);
      setError(null);
      return;
    }

    if (["asset_created", "processing"].includes(muxStatus ?? "")) {
      setState("processing");
      return;
    }

    if (
      muxStatus === "errored" ||
      muxStatus === "cancelled" ||
      muxStatus === "timed_out"
    ) {
      setState("failed");
    }
  }, [muxStatus]);

  async function resetAbandonedUpload() {
    try {
      await fetch(
        `/api/commerce/digital/${catalogItemId}/mux-upload`,
        { method: "DELETE" },
      );
    } catch {
      // Preserve the original upload error. The next POST can also replace
      // a pre-asset waiting/uploading record.
    }
  }

  async function startUpload() {
    if (!file) return;

    const normalizedName = file.name.toLowerCase();
    const supportedExtension =
      normalizedName.endsWith(".mp4") ||
      normalizedName.endsWith(".mov") ||
      normalizedName.endsWith(".m4v") ||
      normalizedName.endsWith(".webm");

    if (
      file.type &&
      !ACCEPTED_TYPES.includes(file.type) &&
      !supportedExtension
    ) {
      setError("Choose an MP4, MOV, M4V, or WebM video.");
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      setError("This video exceeds the 8 GB upload limit.");
      return;
    }

    setState("preparing");
    setError(null);
    setProgress(0);

    try {
      const response = await fetch(
        `/api/commerce/digital/${catalogItemId}/mux-upload`,
        { method: "POST" },
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        uploadUrl?: string;
        error?: string;
      };

      if (!response.ok || !payload.ok || !payload.uploadUrl) {
        throw new Error(payload.error || "Upload could not be prepared.");
      }

      setState("uploading");

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;
        xhr.open("PUT", payload.uploadUrl!, true);
        xhr.setRequestHeader(
          "Content-Type",
          file.type || "application/octet-stream",
        );

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setProgress(Math.round((event.loaded / event.total) * 100));
          }
        };

        xhr.onload = () => {
          xhrRef.current = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(
              new Error(`Upload failed with status ${xhr.status}.`),
            );
          }
        };

        xhr.onerror = () => {
          xhrRef.current = null;
          reject(new Error("The network interrupted the video upload."));
        };

        xhr.onabort = () => {
          xhrRef.current = null;
          reject(new Error("Video upload was cancelled."));
        };

        xhr.send(file);
      });

      const completionResponse = await fetch(
        `/api/commerce/digital/${catalogItemId}/mux-upload`,
        { method: "PATCH" },
      );
      const completionPayload = (await completionResponse.json()) as {
        ok?: boolean;
        error?: string;
      };

      if (!completionResponse.ok || !completionPayload.ok) {
        throw new Error(
          completionPayload.error ||
            "The video uploaded, but DanceFlow could not update its processing status.",
        );
      }

      setState("processing");
      setProgress(100);
      setFile(null);
      setError(null);
      router.refresh();
    } catch (caught) {
      await resetAbandonedUpload();
      setState("failed");
      setError(
        caught instanceof Error
          ? `${caught.message} The incomplete upload was cleared, so you can try again.`
          : "Video upload failed. The incomplete upload was cleared, so you can try again.",
      );
      router.refresh();
    }
  }

  function cancelUpload() {
    xhrRef.current?.abort();
  }

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <UploadCloud className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-slate-950">
            Upload video
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Choose a video file. DanceFlow uploads it directly to Mux and
            handles processing and secure playback settings automatically.
          </p>
        </div>
      </div>

      {(error ||
        (state === "idle" ? errorMessage : null) ||
        (state === "idle" && interruptedServerUpload)) ? (
        <div className="mt-5 flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-900">
          <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="text-sm">
            <p>
              {error ||
                (state === "idle" ? errorMessage : null) ||
                "The previous browser upload did not complete. Choose the file and try again."}
            </p>
            {interruptedServerUpload ? (
              <button
                type="button"
                onClick={async () => {
                  await resetAbandonedUpload();
                  router.refresh();
                }}
                className="mt-3 rounded-lg border border-rose-300 bg-white px-3 py-2 font-semibold text-rose-800"
              >
                Clear incomplete upload
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {muxStatus === "ready" ? (
        <div className="mt-5 flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">Video ready</p>
            <p className="mt-1 text-sm">
              Mux finished processing the video. It is ready for secure
              entitlement-based playback.
            </p>
          </div>
        </div>
      ) : null}

      {muxStatus !== "ready" && (processing || state === "processing") ? (
        <div className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950">
          <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin" />
          <div>
            <p className="font-semibold">Video processing</p>
            <p className="mt-1 text-sm">
              Keep this page open or return later. Mux will notify DanceFlow
              when the video is ready.
            </p>
          </div>
        </div>
      ) : null}

      {muxStatus !== "ready" && !processing && state !== "processing" ? (
        <div className="mt-5 rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-5">
          <label className="block cursor-pointer">
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/x-m4v,video/webm"
              className="sr-only"
              disabled={state === "preparing" || state === "uploading"}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setError(null);
                setProgress(0);
              }}
            />
            <div className="flex flex-col items-center gap-3 text-center">
              <FileVideo className="h-8 w-8 text-[var(--brand-primary)]" />
              <div>
                <p className="font-semibold text-slate-950">
                  {file ? file.name : "Choose a video"}
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  MP4, MOV, M4V, or WebM · up to 8 GB · 1080p recommended
                </p>
              </div>
            </div>
          </label>
        </div>
      ) : null}

      {state === "uploading" ? (
        <div className="mt-5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-slate-700">
              Uploading to Mux
            </span>
            <span className="font-semibold text-slate-950">
              {progress}%
            </span>
          </div>
          <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-[var(--brand-primary)] transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void startUpload();
          }}
          disabled={
            !file ||
            state === "preparing" ||
            state === "uploading" ||
            processing ||
            muxStatus === "ready"
          }
          className="inline-flex items-center gap-2 rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {state === "preparing" || state === "uploading" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <UploadCloud className="h-4 w-4" />
          )}
          {state === "preparing"
            ? "Preparing upload…"
            : state === "uploading"
              ? `Uploading ${progress}%`
              : state === "failed"
                ? "Try upload again"
                : "Upload video"}
        </button>

        {state === "uploading" ? (
          <button
            type="button"
            onClick={cancelUpload}
            className="rounded-xl border border-rose-200 px-4 py-2.5 text-sm font-semibold text-rose-700"
          >
            Cancel upload
          </button>
        ) : null}

        {muxStatus !== "ready" && (processing || state === "processing") ? (
          <button
            type="button"
            onClick={() => router.refresh()}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700"
          >
            <RefreshCcw className="h-4 w-4" />
            Check status
          </button>
        ) : null}
      </div>

      <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-xs text-slate-600">
        <span className="font-semibold text-slate-800">Current status:</span>{" "}
        {state === "uploading"
          ? `Uploading ${progress}%`
          : state === "preparing"
            ? "Preparing secure upload"
            : state === "processing"
              ? "Processing in Mux"
              : processing
                ? "Processing in Mux"
                : muxStatus === "ready"
                  ? "Ready"
                  : interruptedServerUpload
                    ? "Incomplete upload — clear and retry"
                    : state === "failed" || muxStatus === "errored"
                      ? "Upload failed — ready to retry"
                      : "No active upload"}
      </div>

      <p className="mt-3 text-xs text-slate-500">
        The file uploads directly to Mux. DanceFlow never exposes your Mux
        credentials to the browser.
      </p>
    </section>
  );
}
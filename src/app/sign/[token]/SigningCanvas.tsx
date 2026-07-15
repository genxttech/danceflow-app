"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, PenLine, RotateCcw, X } from "lucide-react";
import { completeSigningAction } from "./actions";

type Field = {
  id: string;
  field_type: "signature" | "initials" | "printed_name" | "date" | "text" | "checkbox";
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  required: boolean;
  placeholder_text?: string | null;
  default_value?: string | null;
};

type PageSize = { pageNumber: number; width: number; height: number };
type SignatureMode = "typed" | "drawn";
type SignatureValue = { method: SignatureMode; value: string };

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 6)
    .toUpperCase();
}

function SignatureModal({
  open,
  kind,
  signerName,
  onClose,
  onApply,
}: {
  open: boolean;
  kind: "signature" | "initials";
  signerName: string;
  onClose: () => void;
  onApply: (value: SignatureValue) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const [mode, setMode] = useState<SignatureMode>("typed");
  const [typedValue, setTypedValue] = useState(kind === "initials" ? initials(signerName) : signerName);

  useEffect(() => {
    setTypedValue(kind === "initials" ? initials(signerName) : signerName);
    setMode("typed");
  }, [kind, signerName, open]);

  useEffect(() => {
    if (!open || mode !== "drawn") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
  }, [open, mode]);

  if (!open) return null;

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function startDrawing(event: React.PointerEvent<HTMLCanvasElement>) {
    drawingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const ctx = event.currentTarget.getContext("2d");
    const next = point(event);
    ctx?.beginPath();
    ctx?.moveTo(next.x, next.y);
  }

  function draw(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const ctx = event.currentTarget.getContext("2d");
    const next = point(event);
    ctx?.lineTo(next.x, next.y);
    ctx?.stroke();
  }

  function stopDrawing(event: React.PointerEvent<HTMLCanvasElement>) {
    drawingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function clearCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  }

  function apply() {
    if (mode === "typed") {
      const value = typedValue.trim();
      if (!value) return;
      onApply({ method: "typed", value });
      onClose();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    onApply({ method: "drawn", value: canvas.toDataURL("image/png") });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/60 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-xl rounded-3xl bg-white p-5 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-violet-700">DanceFlow Sign</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              {kind === "initials" ? "Add your initials" : "Add your signature"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">Choose a typed signature or draw with your mouse, finger, or stylus.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl border border-slate-200 p-2 text-slate-600" aria-label="Close signature dialog">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-2 rounded-2xl bg-slate-100 p-1">
          <button type="button" onClick={() => setMode("typed")} className={`rounded-xl px-4 py-2.5 text-sm font-semibold ${mode === "typed" ? "bg-white text-slate-950 shadow-sm" : "text-slate-600"}`}>Type</button>
          <button type="button" onClick={() => setMode("drawn")} className={`rounded-xl px-4 py-2.5 text-sm font-semibold ${mode === "drawn" ? "bg-white text-slate-950 shadow-sm" : "text-slate-600"}`}>Draw</button>
        </div>

        {mode === "typed" ? (
          <div className="mt-5">
            <label className="text-sm font-semibold text-slate-800">
              {kind === "initials" ? "Initials" : "Signature"}
              <input value={typedValue} onChange={(event) => setTypedValue(event.target.value)} className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-lg italic" />
            </label>
            <div className="mt-4 rounded-2xl border border-dashed border-violet-300 bg-violet-50 px-5 py-6 text-center text-3xl italic text-slate-900">
              {typedValue || (kind === "initials" ? "Your initials" : "Your signature")}
            </div>
          </div>
        ) : (
          <div className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-800">Draw inside the box</p>
              <button type="button" onClick={clearCanvas} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700">
                <RotateCcw className="h-4 w-4" /> Clear
              </button>
            </div>
            <canvas
              ref={canvasRef}
              onPointerDown={startDrawing}
              onPointerMove={draw}
              onPointerUp={stopDrawing}
              onPointerCancel={stopDrawing}
              className="mt-3 h-48 w-full touch-none rounded-2xl border-2 border-dashed border-violet-300 bg-white"
            />
          </div>
        )}

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700">Cancel</button>
          <button type="button" onClick={apply} className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white">
            <Check className="h-4 w-4" /> Apply {kind === "initials" ? "initials" : "signature"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SigningCanvas({ token, signerName, fields, pageSizes }: { token: string; signerName: string; fields: Field[]; pageSizes: PageSize[] }) {
  const [page, setPage] = useState(1);
  const [activeField, setActiveField] = useState<Field | null>(null);
  const [signatureValues, setSignatureValues] = useState<Record<string, SignatureValue>>({});
  const [appliedAt, setAppliedAt] = useState<Record<string, string>>({});
  const size = pageSizes.find((item) => item.pageNumber === page) ?? { pageNumber: page, width: 612, height: 792 };
  const pageFields = useMemo(() => fields.filter((field) => field.page_number === page), [fields, page]);
  const today = new Date().toLocaleDateString("en-US");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const pageCount = Math.max(pageSizes.length, 1);
  const canGoPrevious = page > 1;
  const canGoNext = page < pageCount;

  function goToPage(nextPage: number) {
    setPage(Math.min(Math.max(nextPage, 1), pageCount));
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        if (canGoPrevious) {
          event.preventDefault();
          goToPage(page - 1);
        }
      }

      if (event.key === "ArrowRight" || event.key === "PageDown") {
        if (canGoNext) {
          event.preventDefault();
          goToPage(page + 1);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canGoNext, canGoPrevious, page, pageCount]);

  return (
    <>
      <form action={completeSigningAction} className="space-y-5">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="signerName" value={signerName} />
        <input type="hidden" name="timezone" value={timezone} />
        {Object.entries(signatureValues).map(([fieldId, value]) => (
          <input key={fieldId} type="hidden" name={`field_${fieldId}`} value={JSON.stringify(value)} />
        ))}

        <div className="sticky top-3 z-20 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-800">Complete the highlighted fields</p>
              <p className="mt-1 text-xs text-slate-500">
                Use Previous and Next to review every page of the document.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!canGoPrevious}
                onClick={() => goToPage(page - 1)}
                className="inline-flex items-center gap-1 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </button>

              <label className="sr-only" htmlFor="document-page-select">
                Document page
              </label>
              <select
                id="document-page-select"
                value={page}
                onChange={(event) => goToPage(Number(event.target.value))}
                className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
              >
                {pageSizes.map((item) => (
                  <option key={item.pageNumber} value={item.pageNumber}>
                    Page {item.pageNumber} of {pageCount}
                  </option>
                ))}
              </select>

              <button
                type="button"
                disabled={!canGoNext}
                onClick={() => goToPage(page + 1)}
                className="inline-flex items-center gap-1 rounded-xl bg-[var(--brand-primary)] px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-200 p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-slate-600">Page {page} preview</p>
            <a href={`/sign/${encodeURIComponent(token)}/source`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-violet-700 hover:underline">Open document</a>
          </div>
          <div
            className="relative mx-auto w-full overflow-hidden bg-white shadow-lg"
            style={{
              aspectRatio: `${size.width}/${size.height}`,
              maxWidth: size.width,
              minHeight: 520,
            }}
          >
            <iframe
              title={`Document page ${page}`}
              src={`/sign/${encodeURIComponent(token)}/source#page=${page}&toolbar=0&navpanes=0&scrollbar=1&view=FitH`}
              className="absolute inset-0 h-full w-full border-0 pointer-events-none"
            />
            <div className="absolute inset-0">
              {pageFields.map((field) => {
                const style = { left: `${field.x * 100}%`, top: `${field.y * 100}%`, width: `${field.width * 100}%`, height: `${field.height * 100}%` };
                if (field.field_type === "checkbox") {
                  return <label key={field.id} title={field.label} className="absolute grid place-items-center border-2 border-violet-600 bg-white/95 shadow-sm" style={style}><input name={`field_${field.id}`} type="checkbox" required={field.required} className="h-5 w-5" /></label>;
                }
                if (field.field_type === "signature" || field.field_type === "initials") {
                  const signature = signatureValues[field.id];
                  return (
                    <button
                      key={field.id}
                      type="button"
                      onClick={() => setActiveField(field)}
                      className="absolute flex flex-col items-center justify-center overflow-hidden border-2 border-violet-600 bg-white/95 px-1 text-center shadow-sm"
                      style={style}
                    >
                      {signature ? (
                        <>
                          {signature.method === "drawn" ? <img src={signature.value} alt="Applied signature" className="max-h-[70%] max-w-full object-contain" /> : <span className="truncate text-xs italic text-slate-950">{signature.value}</span>}
                          <span className="mt-0.5 text-[9px] font-semibold text-emerald-700">Signed {appliedAt[field.id] ?? "now"}</span>
                        </>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-violet-700"><PenLine className="h-3 w-3" /> Click to {field.field_type === "initials" ? "initial" : "sign"}</span>
                      )}
                    </button>
                  );
                }
                const defaultValue = field.default_value || (field.field_type === "date" ? today : field.field_type === "printed_name" ? signerName : "");
                return <label key={field.id} className="absolute border-2 border-violet-600 bg-white/95 p-0.5 shadow-sm" style={style}><span className="sr-only">{field.label}</span><input name={`field_${field.id}`} required={field.required} defaultValue={defaultValue} placeholder={field.placeholder_text ?? field.label} className="h-full w-full min-w-0 border-0 bg-transparent px-1 text-xs outline-none" /></label>;
              })}
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              disabled={!canGoPrevious}
              onClick={() => goToPage(page - 1)}
              className="inline-flex items-center justify-center gap-1 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
              Previous page
            </button>

            <p className="text-center text-sm font-semibold text-slate-700">
              Page {page} of {pageCount}
            </p>

            <button
              type="button"
              disabled={!canGoNext}
              onClick={() => goToPage(page + 1)}
              className="inline-flex items-center justify-center gap-1 rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next page
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <label className="flex gap-3 text-sm leading-6"><input type="checkbox" name="consent" required className="mt-1" /><span>I have reviewed this document, agree to use electronic records and signatures, and confirm that the signature I apply is my own.</span></label>
          <button className="mt-4 w-full rounded-xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-semibold text-white">Finish and sign</button>
        </div>
      </form>

      <SignatureModal
        open={Boolean(activeField)}
        kind={activeField?.field_type === "initials" ? "initials" : "signature"}
        signerName={signerName}
        onClose={() => setActiveField(null)}
        onApply={(value) => {
          if (!activeField) return;
          setSignatureValues((current) => ({ ...current, [activeField.id]: value }));
          setAppliedAt((current) => ({ ...current, [activeField.id]: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) }));
        }}
      />
    </>
  );
}
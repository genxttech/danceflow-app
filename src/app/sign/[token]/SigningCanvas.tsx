"use client";

import { useMemo, useState } from "react";
import { completeSigningAction } from "./actions";

type Field = { id: string; field_type: "signature" | "initials" | "printed_name" | "date" | "text" | "checkbox"; page_number: number; x: number; y: number; width: number; height: number; label: string; required: boolean; placeholder_text?: string | null; default_value?: string | null };
type PageSize = { pageNumber: number; width: number; height: number };

function initials(name: string) { return name.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 6).toUpperCase(); }

export default function SigningCanvas({ token, signerName, fields, pageSizes }: { token: string; signerName: string; fields: Field[]; pageSizes: PageSize[] }) {
  const [page, setPage] = useState(1);
  const size = pageSizes.find((item) => item.pageNumber === page) ?? { pageNumber: page, width: 612, height: 792 };
  const pageFields = useMemo(() => fields.filter((field) => field.page_number === page), [fields, page]);
  const today = new Date().toLocaleDateString("en-US");
  return <form action={completeSigningAction} className="space-y-5">
    <input type="hidden" name="token" value={token} /><input type="hidden" name="signerName" value={signerName} />
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3"><p className="text-sm font-semibold text-slate-800">Complete the highlighted fields</p><select value={page} onChange={(e) => setPage(Number(e.target.value))} className="rounded-xl border border-slate-300 px-3 py-2 text-sm">{pageSizes.map((item) => <option key={item.pageNumber} value={item.pageNumber}>Page {item.pageNumber}</option>)}</select></div>
    <div className="rounded-2xl border border-slate-200 bg-slate-200 p-3"><div className="relative mx-auto overflow-hidden bg-white shadow-lg" style={{ aspectRatio: `${size.width}/${size.height}`, maxHeight: "78vh" }}>
      <object aria-label={`Document page ${page}`} data={`/sign/${encodeURIComponent(token)}/source#page=${page}&toolbar=0&navpanes=0&scrollbar=0&view=Fit`} type="application/pdf" className="absolute inset-0 h-full w-full pointer-events-none" />
      <div className="absolute inset-0">{pageFields.map((field) => {
        const style = { left: `${field.x * 100}%`, top: `${field.y * 100}%`, width: `${field.width * 100}%`, height: `${field.height * 100}%` };
        if (field.field_type === "checkbox") return <label key={field.id} title={field.label} className="absolute grid place-items-center border-2 border-violet-600 bg-white/95 shadow-sm" style={style}><input name={`field_${field.id}`} type="checkbox" required={field.required} className="h-5 w-5" /></label>;
        const defaultValue = field.default_value || (field.field_type === "date" ? today : field.field_type === "initials" ? initials(signerName) : ["signature", "printed_name"].includes(field.field_type) ? signerName : "");
        return <label key={field.id} className="absolute border-2 border-violet-600 bg-white/95 p-0.5 shadow-sm" style={style}><span className="sr-only">{field.label}</span><input name={`field_${field.id}`} required={field.required} defaultValue={defaultValue} placeholder={field.placeholder_text ?? field.label} className={`h-full w-full min-w-0 border-0 bg-transparent px-1 text-xs outline-none ${field.field_type === "signature" || field.field_type === "initials" ? "italic" : ""}`} /></label>;
      })}</div>
    </div></div>
    <div className="rounded-2xl border border-slate-200 bg-white p-4"><label className="flex gap-3 text-sm leading-6"><input type="checkbox" name="consent" required className="mt-1" /><span>I have reviewed this document and agree to sign it electronically.</span></label><button className="mt-4 w-full rounded-xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-semibold text-white">Finish and sign</button></div>
  </form>;
}

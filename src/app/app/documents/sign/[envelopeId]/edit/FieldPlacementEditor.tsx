"use client";

import { useMemo, useRef, useState } from "react";
import { saveSignFieldsAction, sendSignEnvelopeAction } from "../../actions";

type FieldType = "signature" | "initials" | "printed_name" | "date" | "text" | "checkbox";
type Field = { id: string; field_type: FieldType; page_number: number; x: number; y: number; width: number; height: number; label: string; required: boolean; placeholder_text?: string | null; default_value?: string | null };
type PageSize = { pageNumber: number; width: number; height: number };

const LABELS: Record<FieldType, string> = { signature: "Signature", initials: "Initials", printed_name: "Printed name", date: "Date", text: "Text", checkbox: "Checkbox" };
const DEFAULT_SIZE: Record<FieldType, [number, number]> = { signature: [0.34, 0.07], initials: [0.18, 0.06], printed_name: [0.30, 0.055], date: [0.20, 0.05], text: [0.30, 0.055], checkbox: [0.05, 0.05] };

export default function FieldPlacementEditor({ envelopeId, pageSizes, initialFields }: { envelopeId: string; pageSizes: PageSize[]; initialFields: Field[] }) {
  const [page, setPage] = useState(1);
  const [fields, setFields] = useState<Field[]>(initialFields);
  const [selectedId, setSelectedId] = useState<string | null>(initialFields[0]?.id ?? null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const currentSize = pageSizes.find((item) => item.pageNumber === page) ?? { pageNumber: page, width: 612, height: 792 };
  const selected = fields.find((field) => field.id === selectedId) ?? null;
  const pageFields = useMemo(() => fields.filter((field) => field.page_number === page), [fields, page]);

  function addField(type: FieldType) {
    const [width, height] = DEFAULT_SIZE[type];
    const field: Field = { id: crypto.randomUUID(), field_type: type, page_number: page, x: 0.08, y: 0.08, width, height, label: LABELS[type], required: true, placeholder_text: type === "text" ? "Enter response" : null, default_value: null };
    setFields((current) => [...current, field]); setSelectedId(field.id);
  }
  function updateField(id: string, patch: Partial<Field>) { setFields((current) => current.map((field) => field.id === id ? { ...field, ...patch } : field)); }
  function removeSelected() { if (!selectedId) return; setFields((current) => current.filter((field) => field.id !== selectedId)); setSelectedId(null); }
  function duplicateSelected() { if (!selected) return; const clone = { ...selected, id: crypto.randomUUID(), x: Math.min(0.95 - selected.width, selected.x + 0.03), y: Math.min(0.95 - selected.height, selected.y + 0.03) }; setFields((current) => [...current, clone]); setSelectedId(clone.id); }

  function startDrag(event: React.PointerEvent, field: Field, resize = false) {
    event.preventDefault(); event.stopPropagation(); setSelectedId(field.id);
    const surface = surfaceRef.current; if (!surface) return;
    const rect = surface.getBoundingClientRect(); const startX = event.clientX; const startY = event.clientY; const original = { ...field };
    const move = (pointer: PointerEvent) => {
      const dx = (pointer.clientX - startX) / rect.width; const dy = (pointer.clientY - startY) / rect.height;
      if (resize) updateField(field.id, { width: Math.max(0.04, Math.min(1 - original.x, original.width + dx)), height: Math.max(0.035, Math.min(1 - original.y, original.height + dy)) });
      else updateField(field.id, { x: Math.max(0, Math.min(1 - original.width, original.x + dx)), y: Math.max(0, Math.min(1 - original.height, original.y + dy)) });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }

  return <div className="grid gap-5 xl:grid-cols-[220px_minmax(0,1fr)_300px]">
    <aside className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="font-semibold text-slate-950">Add fields</h2><p className="mt-1 text-xs leading-5 text-slate-500">Choose a field, then drag and resize it on the document.</p>
      <div className="mt-4 grid gap-2">{(Object.keys(LABELS) as FieldType[]).map((type) => <button key={type} type="button" onClick={() => addField(type)} className="rounded-xl border border-slate-300 px-3 py-2 text-left text-sm font-medium hover:bg-slate-50">+ {LABELS[type]}</button>)}</div>
      <div className="mt-5 border-t border-slate-200 pt-4"><label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Page<select value={page} onChange={(e) => setPage(Number(e.target.value))} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm">{pageSizes.map((item) => <option key={item.pageNumber} value={item.pageNumber}>Page {item.pageNumber}</option>)}</select></label></div>
    </aside>

    <section className="min-w-0 rounded-2xl border border-slate-200 bg-slate-200 p-3 shadow-sm">
      <div ref={surfaceRef} className="relative mx-auto overflow-hidden bg-white shadow-lg" style={{ aspectRatio: `${currentSize.width}/${currentSize.height}`, maxHeight: "78vh" }}>
        <object aria-label={`PDF page ${page}`} data={`/app/documents/sign/${envelopeId}/source#page=${page}&toolbar=0&navpanes=0&scrollbar=0&view=Fit`} type="application/pdf" className="absolute inset-0 h-full w-full pointer-events-none" />
        <div className="absolute inset-0" onPointerDown={() => setSelectedId(null)}>
          {pageFields.map((field) => <div key={field.id} onPointerDown={(event) => startDrag(event, field)} className={`absolute cursor-move select-none rounded border-2 px-2 py-1 text-[11px] font-semibold shadow-sm ${selectedId === field.id ? "border-violet-700 bg-violet-100/90" : "border-violet-400 bg-violet-50/85"}`} style={{ left: `${field.x * 100}%`, top: `${field.y * 100}%`, width: `${field.width * 100}%`, height: `${field.height * 100}%` }}>
            <span className="truncate">{field.label}{field.required ? " *" : ""}</span>
            {selectedId === field.id ? <button type="button" aria-label="Resize field" onPointerDown={(event) => startDrag(event, field, true)} className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-se-resize rounded-sm bg-violet-700" /> : null}
          </div>)}
        </div>
      </div>
    </section>

    <aside className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="font-semibold text-slate-950">Field settings</h2>
      {!selected ? <p className="mt-4 text-sm text-slate-500">Select a field to edit it.</p> : <div className="mt-4 space-y-4">
        <label className="block text-sm font-medium">Label<input value={selected.label} onChange={(e) => updateField(selected.id, { label: e.target.value })} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2" /></label>
        <label className="block text-sm font-medium">Page<select value={selected.page_number} onChange={(e) => updateField(selected.id, { page_number: Number(e.target.value) })} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2">{pageSizes.map((item) => <option key={item.pageNumber} value={item.pageNumber}>Page {item.pageNumber}</option>)}</select></label>
        {selected.field_type === "text" ? <label className="block text-sm font-medium">Placeholder<input value={selected.placeholder_text ?? ""} onChange={(e) => updateField(selected.id, { placeholder_text: e.target.value })} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2" /></label> : null}
        <label className="flex items-center gap-3 text-sm font-medium"><input type="checkbox" checked={selected.required} onChange={(e) => updateField(selected.id, { required: e.target.checked })} /> Required</label>
        <div className="grid grid-cols-2 gap-2"><button type="button" onClick={duplicateSelected} className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold">Duplicate</button><button type="button" onClick={removeSelected} className="rounded-xl border border-rose-300 px-3 py-2 text-sm font-semibold text-rose-700">Delete</button></div>
      </div>}
      <form action={saveSignFieldsAction} className="mt-6 space-y-2"><input type="hidden" name="envelopeId" value={envelopeId} /><input type="hidden" name="fieldsJson" value={JSON.stringify(fields)} /><button className="w-full rounded-xl border border-violet-300 px-4 py-2.5 text-sm font-semibold text-violet-800">Save field layout</button></form>
      <form action={sendSignEnvelopeAction} className="mt-2"><input type="hidden" name="envelopeId" value={envelopeId} /><button className="w-full rounded-xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-semibold text-white">Send for signature</button></form>
      <p className="mt-3 text-xs leading-5 text-slate-500">Save before sending. Once sent, the field layout is locked.</p>
    </aside>
  </div>;
}

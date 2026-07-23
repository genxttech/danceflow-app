"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, CalendarDays, MapPin, Sparkles } from "lucide-react";
import ResponsiveDetailPanel from "@/components/app/workspace/ResponsiveDetailPanel";

export type ScheduleDetailItem = {
  label: string;
  value: string;
};

export default function ScheduleDetailPanelTrigger({
  kind,
  title,
  description,
  status,
  details,
  note,
  primaryHref,
  primaryLabel,
  secondaryHref,
  secondaryLabel,
  triggerLabel,
  triggerClassName,
}: {
  kind: "appointment" | "event";
  title: string;
  description: string;
  status: string;
  details: ScheduleDetailItem[];
  note?: string;
  primaryHref: string;
  primaryLabel: string;
  secondaryHref?: string;
  secondaryLabel?: string;
  triggerLabel?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={triggerClassName}>
        {triggerLabel ?? title}
      </button>

      <ResponsiveDetailPanel
        open={open}
        title={title}
        description={description}
        onClose={() => setOpen(false)}
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-xl border border-violet-200 bg-white px-4 py-2.5 text-sm font-semibold text-violet-800 hover:bg-violet-50"
            >
              Keep reviewing schedule
            </button>
            {secondaryHref && secondaryLabel ? (
              <Link
                href={secondaryHref}
                className="inline-flex items-center justify-center rounded-xl border border-orange-200 bg-white px-4 py-2.5 text-sm font-semibold text-orange-800 hover:bg-orange-50"
              >
                {secondaryLabel}
              </Link>
            ) : null}
            <Link
              href={primaryHref}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-110"
            >
              {primaryLabel}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        }
      >
        <div className="space-y-4 p-5">
          <section className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <span className="rounded-xl bg-[linear-gradient(135deg,#ede9fe_0%,#ffedd5_100%)] p-2 text-violet-800 ring-1 ring-violet-200">
                {kind === "event" ? <Sparkles className="h-4 w-4" /> : <CalendarDays className="h-4 w-4" />}
              </span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                  {kind === "event" ? "Event details" : "Appointment details"}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-semibold capitalize text-violet-800">
                    {status.replaceAll("_", " ")}
                  </span>
                  <span className="text-sm text-slate-600">{description}</span>
                </div>
              </div>
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            {details.map((detail) => (
              <div
                key={`${detail.label}-${detail.value}`}
                className="rounded-2xl border border-orange-100 bg-[linear-gradient(135deg,#ffffff_0%,#fff7ed_100%)] p-4"
              >
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-700">
                  {detail.label}
                </p>
                <p className="mt-2 text-sm font-medium leading-6 text-slate-900">
                  {detail.value}
                </p>
              </div>
            ))}
          </section>

          {note ? (
            <section className="rounded-2xl border border-violet-100 bg-[linear-gradient(135deg,#faf5ff_0%,#ffffff_100%)] p-4">
              <div className="flex items-start gap-3">
                <MapPin className="mt-0.5 h-4 w-4 text-violet-700" />
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
                    Operational note
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-700">{note}</p>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </ResponsiveDetailPanel>
    </>
  );
}

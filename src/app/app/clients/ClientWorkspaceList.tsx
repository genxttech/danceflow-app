"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Archive,
  ArrowRight,
  CalendarPlus,
  Clock3,
  FileText,
  Mail,
  Pencil,
  Phone,
  UserRound,
} from "lucide-react";
import ResponsiveDetailPanel from "@/components/app/workspace/ResponsiveDetailPanel";
import { archiveClientAction } from "./actions";
import type { ClientRow } from "./page";
import { getClientLifecycleAction } from "@/lib/clients/lifecycle";

function statusBadgeClass(status: string) {
  if (status === "lead") return "border-sky-200 bg-sky-50 text-sky-700";
  if (status === "contacted") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "consultation_booked") return "border-violet-200 bg-violet-50 text-violet-700";
  if (status === "converted") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "lost") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "active") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "inactive") return "border-slate-200 bg-slate-100 text-slate-700";
  if (status === "archived") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function statusLabel(status: string) {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}


function lifecycleBadgeClass(stage: ClientRow["lifecycle_stage"]) {
  if (["active_student", "new_student", "recovered"].includes(stage)) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (["new_lead", "contacted", "intro_scheduled"].includes(stage)) {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }
  if (["conversion_pending", "needs_rebooking"].includes(stage)) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (stage === "retention_risk") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function formatLifecycleDate(value: string | null) {
  if (!value) return "No activity recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No activity recorded";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function initialsFor(client: Pick<ClientRow, "first_name" | "last_name">) {
  return `${client.first_name.charAt(0)}${client.last_name.charAt(0)}`.toUpperCase();
}

function displayName(client: ClientRow) {
  return `${client.first_name} ${client.last_name}`.trim() || "Client";
}

export default function ClientWorkspaceList({
  clients,
}: {
  clients: ClientRow[];
}) {
  const [selectedClient, setSelectedClient] = useState<ClientRow | null>(null);

  return (
    <>
      <div>
        {clients.map((client) => (
          <div
            key={client.id}
            className="grid border-b border-[var(--brand-border)] last:border-b-0 lg:grid-cols-[minmax(0,1fr)_auto]"
          >
            <button
              type="button"
              onClick={() => setSelectedClient(client)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-[linear-gradient(90deg,rgba(124,58,237,0.06),rgba(249,115,22,0.05))] sm:px-5"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--brand-primary-soft)] text-sm font-semibold text-[var(--brand-primary)]">
                {initialsFor(client)}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-[var(--brand-text)]">
                      {displayName(client)}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-[var(--brand-muted)]">
                      {[client.email, client.phone].filter(Boolean).join(" • ") ||
                        "No contact information"}
                    </span>
                  </span>

                  <span className="flex shrink-0 flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${lifecycleBadgeClass(
                        client.lifecycle_stage,
                      )}`}
                    >
                      {client.lifecycle_label}
                    </span>
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusBadgeClass(
                        client.status,
                      )}`}
                    >
                      Record: {statusLabel(client.status)}
                    </span>
                    {client.skill_level ? (
                      <span className="inline-flex rounded-full border border-indigo-100 bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                        {client.skill_level}
                      </span>
                    ) : null}
                  </span>
                </span>

                <span className="mt-2 flex flex-wrap gap-2">
                  {client.dance_interests ? (
                    <span className="max-w-[18rem] truncate rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-medium text-orange-800">
                      {client.dance_interests}
                    </span>
                  ) : null}
                  {client.referral_source ? (
                    <span className="max-w-[14rem] truncate rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-800">
                      {client.referral_source.replaceAll("_", " ")}
                    </span>
                  ) : null}
                </span>
              </span>

              <ArrowRight className="h-4 w-4 shrink-0 text-[var(--brand-muted)]" />
            </button>

            <div className="flex items-center gap-2 border-t border-[var(--brand-border)] px-4 py-2 lg:border-l lg:border-t-0">
              <Link
                href={`/app/clients/${client.id}/edit`}
                className="rounded-lg border border-[var(--brand-border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
              >
                Edit
              </Link>

              {client.status !== "archived" ? (
                <form action={archiveClientAction}>
                  <input type="hidden" name="clientId" value={client.id} />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    Archive
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <ResponsiveDetailPanel
        open={Boolean(selectedClient)}
        title={selectedClient ? displayName(selectedClient) : "Client details"}
        description={
          selectedClient
            ? `${selectedClient.lifecycle_label} · ${statusLabel(selectedClient.status)} record`
            : undefined
        }
        onClose={() => setSelectedClient(null)}
        footer={
          selectedClient ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
              <button
                type="button"
                onClick={() => setSelectedClient(null)}
                className="rounded-xl border border-violet-200 bg-white px-4 py-2.5 text-sm font-semibold text-violet-800 hover:bg-violet-50"
              >
                Keep reviewing clients
              </button>
              <Link
                href={`/app/clients/${selectedClient.id}`}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-110"
              >
                Open full profile
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          ) : null
        }
      >
        {selectedClient ? (() => {
          const lifecycleAction = getClientLifecycleAction({
            clientId: selectedClient.id,
            stage: selectedClient.lifecycle_stage,
          });

          return (
          <div className="space-y-4 p-5">
            <section className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#4c1d95_0%,#f97316_130%)] text-sm font-bold text-white shadow-sm">
                  {initialsFor(selectedClient)}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                    Client summary
                  </p>
                  <h3 className="mt-1 text-xl font-semibold text-slate-950">
                    {displayName(selectedClient)}
                  </h3>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${lifecycleBadgeClass(
                        selectedClient.lifecycle_stage,
                      )}`}
                    >
                      {selectedClient.lifecycle_label}
                    </span>
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(
                        selectedClient.status,
                      )}`}
                    >
                      Record: {statusLabel(selectedClient.status)}
                    </span>
                    {selectedClient.skill_level ? (
                      <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">
                        {selectedClient.skill_level}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-violet-200 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                Client journey
              </p>
              <p className="mt-2 text-base font-semibold text-slate-950">
                {selectedClient.lifecycle_label}
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-700">
                {selectedClient.lifecycle_description}
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-white/80 bg-white/80 p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                    <Clock3 className="h-3.5 w-3.5" />
                    Last meaningful activity
                  </div>
                  <p className="mt-2 text-sm font-medium text-slate-900">
                    {formatLifecycleDate(selectedClient.lifecycle_last_activity_at)}
                  </p>
                </div>
                <div className="rounded-xl border border-white/80 bg-white/80 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                    Next expected step
                  </p>
                  <p className="mt-2 text-sm font-medium leading-6 text-slate-900">
                    {selectedClient.lifecycle_next_step}
                  </p>
                </div>
              </div>
              {selectedClient.lifecycle_risk_reason ? (
                <div className={`mt-3 rounded-xl border p-3 text-sm ${
                  selectedClient.lifecycle_risk === "high"
                    ? "border-rose-200 bg-rose-50 text-rose-800"
                    : "border-amber-200 bg-amber-50 text-amber-800"
                }`}>
                  {selectedClient.lifecycle_risk_reason}
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-orange-100 bg-[linear-gradient(135deg,#fff7ed_0%,#faf5ff_100%)] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-700">
                Contact
              </p>
              <div className="mt-3 space-y-3">
                <div className="flex items-start gap-3">
                  <Mail className="mt-0.5 h-4 w-4 text-violet-700" />
                  <div>
                    <p className="text-xs font-semibold text-slate-500">Email</p>
                    <p className="mt-0.5 text-sm text-slate-900">
                      {selectedClient.email || "No email on file"}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Phone className="mt-0.5 h-4 w-4 text-orange-700" />
                  <div>
                    <p className="text-xs font-semibold text-slate-500">Phone</p>
                    <p className="mt-0.5 text-sm text-slate-900">
                      {selectedClient.phone || "No phone on file"}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                Relationship context
              </p>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-slate-50 p-3">
                  <dt className="text-xs font-semibold text-slate-500">
                    Dance interests
                  </dt>
                  <dd className="mt-1 text-sm font-medium text-slate-900">
                    {selectedClient.dance_interests || "Not recorded"}
                  </dd>
                </div>
                <div className="rounded-xl bg-slate-50 p-3">
                  <dt className="text-xs font-semibold text-slate-500">
                    Referral source
                  </dt>
                  <dd className="mt-1 text-sm font-medium capitalize text-slate-900">
                    {selectedClient.referral_source?.replaceAll("_", " ") ||
                      "Not recorded"}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="rounded-2xl border border-sky-100 bg-[linear-gradient(135deg,#eff6ff_0%,#faf5ff_100%)] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">
                Journey action
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {selectedClient.lifecycle_next_step}
              </p>
              <p className="mt-2 text-xs font-medium text-violet-700">
                ARIA: {lifecycleAction.ariaPrompt}
              </p>
              {lifecycleAction.href ? (
                <Link
                  href={lifecycleAction.href}
                  className="mt-3 inline-flex items-center gap-2 rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-110"
                >
                  {lifecycleAction.label}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              ) : null}
            </section>

            <section className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                Quick actions
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Link
                  href={`/app/clients/${selectedClient.id}/edit`}
                  className="inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-white px-3 py-2.5 text-sm font-semibold text-violet-800 hover:bg-violet-50"
                >
                  <Pencil className="h-4 w-4" />
                  Edit client
                </Link>
                <Link
                  href={`/app/schedule/new?clientId=${selectedClient.id}`}
                  className="inline-flex items-center gap-2 rounded-xl border border-orange-200 bg-white px-3 py-2.5 text-sm font-semibold text-orange-800 hover:bg-orange-50"
                >
                  <CalendarPlus className="h-4 w-4" />
                  Book appointment
                </Link>
                <Link
                  href={`/app/clients/${selectedClient.id}/documents`}
                  className="inline-flex items-center gap-2 rounded-xl border border-sky-200 bg-white px-3 py-2.5 text-sm font-semibold text-sky-800 hover:bg-sky-50"
                >
                  <FileText className="h-4 w-4" />
                  Documents
                </Link>
                <Link
                  href={`/app/clients/${selectedClient.id}`}
                  className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-white px-3 py-2.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
                >
                  <UserRound className="h-4 w-4" />
                  Full profile
                </Link>
              </div>
            </section>
          </div>
          );
        })() : null}
      </ResponsiveDetailPanel>
    </>
  );
}

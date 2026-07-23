"use client";

import Link from "next/link";
import { useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowRight,
  CalendarPlus,
  CheckCircle2,
  Mail,
  MessageSquareText,
  Pencil,
  Phone,
  Sparkles,
  UserRoundCheck,
} from "lucide-react";
import ResponsiveDetailPanel from "@/components/app/workspace/ResponsiveDetailPanel";
import { archiveLeadAction, convertLeadToActiveAction } from "./actions";
import type {
  BookingRequestState,
  FollowUpRow,
  LeadRow,
} from "./page";

type Variant = "priority" | "follow-up" | "table";

function sourceLabel(source: string | null) {
  switch (source) {
    case "public_intro_booking":
      return "Public Intro";
    case "event_registration":
      return "Event Registration";
    case "public_directory_inquiry":
    case "public_directory":
      return "Public Directory";
    case "website_form":
      return "Website";
    case "manual":
    case null:
      return "Manual";
    case "import":
      return "Import";
    case "referral":
      return "Referral";
    default:
      return source
        .replaceAll("_", " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

function sourceBadgeClass(source: string | null) {
  switch (source) {
    case "public_intro_booking":
      return "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200";
    case "event_registration":
      return "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200";
    case "public_directory_inquiry":
    case "public_directory":
      return "bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200";
    case "website_form":
      return "bg-cyan-50 text-cyan-700 ring-1 ring-inset ring-cyan-200";
    case "manual":
    case null:
      return "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200";
    default:
      return "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200";
  }
}

function statusBadgeClass(status: string) {
  if (status === "lead") {
    return "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200";
  }
  if (status === "active") {
    return "bg-green-50 text-green-700 ring-1 ring-inset ring-green-200";
  }
  if (status === "archived") {
    return "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200";
  }
  return "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200";
}

function activityLabel(value: string) {
  if (value === "follow_up") return "Follow Up";
  if (value === "call") return "Call";
  if (value === "text") return "Text";
  if (value === "email") return "Email";
  if (value === "consultation") return "Consultation";
  return "Note";
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatShortDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function getClientRecord(value: FollowUpRow["clients"]) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function getClientName(value: FollowUpRow["clients"]) {
  const client = getClientRecord(value);
  return client ? `${client.first_name} ${client.last_name}` : "Unknown Client";
}

function getClientSource(value: FollowUpRow["clients"]) {
  return getClientRecord(value)?.referral_source ?? null;
}

function recommendedActionLabel(
  lead: LeadRow,
  bookingRequestState?: BookingRequestState,
) {
  if (bookingRequestState?.hasPending) return "Review booking request";
  if (bookingRequestState?.hasApproved) return "Open lead";
  if (lead.referral_source === "public_intro_booking") return "Book intro";
  if (lead.referral_source === "event_registration") {
    return "Convert after attendance";
  }
  if (
    lead.referral_source === "public_directory" ||
    lead.referral_source === "public_directory_inquiry"
  ) {
    return "Call or text back";
  }
  return "Open lead";
}

function recommendedActionHref(
  lead: LeadRow,
  bookingRequestState?: BookingRequestState,
) {
  if (bookingRequestState?.hasPending) {
    return "/app/schedule/requests?status=pending";
  }

  if (
    lead.referral_source === "public_intro_booking" &&
    !bookingRequestState?.hasApproved
  ) {
    return `/app/schedule/new?clientId=${lead.id}`;
  }

  return `/app/clients/${lead.id}`;
}

function ariaRecommendation(
  lead: LeadRow,
  bookingRequestState?: BookingRequestState,
) {
  if (bookingRequestState?.hasPending) {
    return "A booking request is waiting. Review it before sending another invitation or scheduling duplicate outreach.";
  }

  if (lead.referral_source === "public_intro_booking") {
    return "This lead has high booking intent. Confirm the intro lesson quickly and keep the path to the first paid lesson clear.";
  }

  if (lead.referral_source === "event_registration") {
    return "Use the event context to personalize follow-up and invite this dancer into the next class, lesson, or offer.";
  }

  if (
    lead.referral_source === "public_directory" ||
    lead.referral_source === "public_directory_inquiry"
  ) {
    return "Respond quickly while the studio search is still active. A call or text is likely the best first action.";
  }

  return "Open the lead record, confirm contact details, and set a clear next follow-up so this opportunity stays visible.";
}

export default function LeadsWorkspacePanels({
  variant,
  leads,
  followUps,
  bookingRequestStates,
  returnTo,
  followUpView = "priority",
}: {
  variant: Variant;
  leads: LeadRow[];
  followUps: FollowUpRow[];
  bookingRequestStates: Record<string, BookingRequestState>;
  returnTo: string;
  followUpView?: string;
}) {
  const [selectedLead, setSelectedLead] = useState<LeadRow | null>(null);
  const [selectedFollowUp, setSelectedFollowUp] =
    useState<FollowUpRow | null>(null);

  const selectedBookingState = selectedLead
    ? bookingRequestStates[selectedLead.id]
    : undefined;

  const panelOpen = Boolean(selectedLead || selectedFollowUp);
  const panelTitle = selectedLead
    ? `${selectedLead.first_name} ${selectedLead.last_name}`
    : selectedFollowUp
      ? getClientName(selectedFollowUp.clients)
      : "Lead details";

  const panelDescription = selectedLead
    ? `${sourceLabel(selectedLead.referral_source)} lead`
    : selectedFollowUp
      ? `${activityLabel(selectedFollowUp.activity_type)} follow-up`
      : undefined;

  const closePanel = () => {
    setSelectedLead(null);
    setSelectedFollowUp(null);
  };

  const leadRows = leads.map((lead) => {
    const bookingState = bookingRequestStates[lead.id];
    const actionLabel = recommendedActionLabel(lead, bookingState);

    if (variant === "table") {
      return (
        <tr
          key={lead.id}
          className="border-t border-slate-200 align-top hover:bg-violet-50/30"
        >
          <td className="px-4 py-4">
            <button
              type="button"
              onClick={() => setSelectedLead(lead)}
              className="font-medium text-slate-900 hover:text-violet-800"
            >
              {lead.first_name} {lead.last_name}
            </button>
            <div className="mt-1">
              <span
                className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                  lead.status,
                )}`}
              >
                {lead.status}
              </span>
            </div>
          </td>
          <td className="px-4 py-4">
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${sourceBadgeClass(
                lead.referral_source,
              )}`}
            >
              {sourceLabel(lead.referral_source)}
            </span>
          </td>
          <td className="px-4 py-4 text-slate-600">
            <div className="space-y-1">
              <div>{lead.email ?? "—"}</div>
              <div>{lead.phone ?? "—"}</div>
            </div>
          </td>
          <td className="px-4 py-4 text-slate-600">
            {lead.dance_interests ?? "—"}
          </td>
          <td className="px-4 py-4 text-slate-600">
            <div>{formatShortDate(lead.created_at)}</div>
            <div className="text-xs text-slate-400">
              {formatDateTime(lead.created_at)}
            </div>
          </td>
          <td className="px-4 py-4">
            <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
              {actionLabel}
            </span>
          </td>
          <td className="px-4 py-4">
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setSelectedLead(lead)}
                className="font-medium text-violet-800 underline"
              >
                Review
              </button>
              <Link
                href={`/app/clients/${lead.id}/edit`}
                className="text-slate-700 underline"
              >
                Edit
              </Link>
              <form action={convertLeadToActiveAction}>
                <input type="hidden" name="clientId" value={lead.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <button type="submit" className="text-green-700 underline">
                  Convert active
                </button>
              </form>
              <form action={archiveLeadAction}>
                <input type="hidden" name="clientId" value={lead.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <button type="submit" className="text-red-600 underline">
                  Archive
                </button>
              </form>
            </div>
          </td>
        </tr>
      );
    }

    return (
      <button
        key={lead.id}
        type="button"
        onClick={() => setSelectedLead(lead)}
        className="block w-full rounded-2xl border border-violet-100 bg-[linear-gradient(135deg,#ffffff_0%,#faf5ff_55%,#fff7ed_100%)] p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-md"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-base font-semibold text-slate-900">
                {lead.first_name} {lead.last_name}
              </p>
              <span
                className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${sourceBadgeClass(
                  lead.referral_source,
                )}`}
              >
                {sourceLabel(lead.referral_source)}
              </span>
              <span
                className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                  lead.status,
                )}`}
              >
                {lead.status}
              </span>
            </div>

            <div className="mt-2 grid gap-1 text-sm text-slate-600">
              <p>{lead.email ?? "No email"}</p>
              <p>{lead.phone ?? "No phone"}</p>
              <p>Created {formatDateTime(lead.created_at)}</p>
              <p>Interest: {lead.dance_interests ?? "—"}</p>
            </div>

            <div className="mt-3">
              <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200">
                Recommended: {actionLabel}
              </span>
            </div>
          </div>

          <span className="inline-flex items-center gap-2 self-start rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-3 py-2 text-sm font-semibold text-white">
            Review lead
            <ArrowRight className="h-4 w-4" />
          </span>
        </div>
      </button>
    );
  });

  const followUpRows = followUps.map((item) => {
    const clientSource = getClientSource(item.clients);
    const statusLabel =
      followUpView === "completed"
        ? "Completed"
        : followUpView === "today"
          ? "Today"
          : "Overdue";

    return (
      <button
        key={item.id}
        type="button"
        onClick={() => setSelectedFollowUp(item)}
        className="block w-full rounded-2xl border border-violet-100 bg-[linear-gradient(135deg,#ffffff_0%,#faf5ff_55%,#fff7ed_100%)] p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-md"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-slate-900">
                {getClientName(item.clients)}
              </p>
              <span
                className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${sourceBadgeClass(
                  clientSource,
                )}`}
              >
                {sourceLabel(clientSource)}
              </span>
            </div>

            <p className="mt-1 text-sm text-slate-600">
              {activityLabel(item.activity_type)}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {item.note || "No note"}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              {followUpView === "completed"
                ? `Completed ${formatDateTime(item.completed_at)}`
                : `Due ${formatDateTime(item.follow_up_due_at)}`}
            </p>
          </div>

          <span
            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
              followUpView === "completed"
                ? "bg-green-50 text-green-700 ring-1 ring-inset ring-green-200"
                : followUpView === "today"
                  ? "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200"
                  : "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200"
            }`}
          >
            {statusLabel}
          </span>
        </div>
      </button>
    );
  });

  return (
    <>
      {variant === "table" ? leadRows : <div className="space-y-3">{leadRows}{followUpRows}</div>}

      {typeof document !== "undefined"
        ? createPortal(
            (
      <ResponsiveDetailPanel
                      open={panelOpen}
                      title={panelTitle}
                      description={panelDescription}
                      onClose={closePanel}
                      footer={
                        selectedLead ? (
                          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                            <button
                              type="button"
                              onClick={closePanel}
                              className="rounded-xl border border-violet-200 bg-white px-4 py-2.5 text-sm font-semibold text-violet-800 hover:bg-violet-50"
                            >
                              Keep reviewing leads
                            </button>
                            <Link
                              href={recommendedActionHref(selectedLead, selectedBookingState)}
                              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-110"
                            >
                              {recommendedActionLabel(selectedLead, selectedBookingState)}
                              <ArrowRight className="h-4 w-4" />
                            </Link>
                          </div>
                        ) : selectedFollowUp ? (
                          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                            <button
                              type="button"
                              onClick={closePanel}
                              className="rounded-xl border border-violet-200 bg-white px-4 py-2.5 text-sm font-semibold text-violet-800 hover:bg-violet-50"
                            >
                              Keep reviewing follow-ups
                            </button>
                            <Link
                              href={`/app/clients/${selectedFollowUp.client_id}`}
                              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-110"
                            >
                              Open lead profile
                              <ArrowRight className="h-4 w-4" />
                            </Link>
                          </div>
                        ) : null
                      }
                    >
                      {selectedLead ? (
                        <div className="space-y-4 p-5">
                          <section className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
                            <div className="flex items-start gap-3">
                              <span className="rounded-xl bg-[linear-gradient(135deg,#ede9fe_0%,#ffedd5_100%)] p-2 text-violet-800 ring-1 ring-violet-200">
                                <Sparkles className="h-4 w-4" />
                              </span>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                                  Lead context
                                </p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  <span
                                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${sourceBadgeClass(
                                      selectedLead.referral_source,
                                    )}`}
                                  >
                                    {sourceLabel(selectedLead.referral_source)}
                                  </span>
                                  <span
                                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                                      selectedLead.status,
                                    )}`}
                                  >
                                    {selectedLead.status}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </section>
              
                          <section className="rounded-2xl border border-orange-100 bg-[linear-gradient(135deg,#fff7ed_0%,#faf5ff_100%)] p-4">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-700">
                              Contact
                            </p>
                            <div className="mt-3 space-y-3">
                              <div className="flex items-start gap-3">
                                <Mail className="mt-0.5 h-4 w-4 text-violet-700" />
                                <p className="text-sm text-slate-900">
                                  {selectedLead.email || "No email on file"}
                                </p>
                              </div>
                              <div className="flex items-start gap-3">
                                <Phone className="mt-0.5 h-4 w-4 text-orange-700" />
                                <p className="text-sm text-slate-900">
                                  {selectedLead.phone || "No phone on file"}
                                </p>
                              </div>
                            </div>
                          </section>
              
                          <section className="grid gap-3 sm:grid-cols-2">
                            <div className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
                              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
                                Interest
                              </p>
                              <p className="mt-2 text-sm font-medium text-slate-900">
                                {selectedLead.dance_interests || "Not recorded"}
                              </p>
                            </div>
                            <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4">
                              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
                                Created
                              </p>
                              <p className="mt-2 text-sm font-medium text-slate-900">
                                {formatDateTime(selectedLead.created_at)}
                              </p>
                            </div>
                          </section>
              
                          <section className="rounded-2xl border border-sky-100 bg-sky-50/70 p-4">
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-700">
                              ARIA recommendation
                            </p>
                            <p className="mt-2 text-sm leading-6 text-slate-700">
                              {ariaRecommendation(selectedLead, selectedBookingState)}
                            </p>
                          </section>
              
                          <section className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
                              Quick actions
                            </p>
                            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                              <Link
                                href={`/app/clients/${selectedLead.id}/edit`}
                                className="inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-white px-3 py-2.5 text-sm font-semibold text-violet-800 hover:bg-violet-50"
                              >
                                <Pencil className="h-4 w-4" />
                                Edit lead
                              </Link>
                              <Link
                                href={`/app/schedule/new?clientId=${selectedLead.id}`}
                                className="inline-flex items-center gap-2 rounded-xl border border-orange-200 bg-white px-3 py-2.5 text-sm font-semibold text-orange-800 hover:bg-orange-50"
                              >
                                <CalendarPlus className="h-4 w-4" />
                                Schedule
                              </Link>
                              <Link
                                href={`/app/activity/new?clientId=${selectedLead.id}`}
                                className="inline-flex items-center gap-2 rounded-xl border border-sky-200 bg-white px-3 py-2.5 text-sm font-semibold text-sky-800 hover:bg-sky-50"
                              >
                                <MessageSquareText className="h-4 w-4" />
                                Add follow-up
                              </Link>
                              <Link
                                href={`/app/clients/${selectedLead.id}`}
                                className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-white px-3 py-2.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
                              >
                                <UserRoundCheck className="h-4 w-4" />
                                Full lead profile
                              </Link>
                            </div>
                          </section>
              
                          <section className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <form action={convertLeadToActiveAction}>
                              <input type="hidden" name="clientId" value={selectedLead.id} />
                              <input type="hidden" name="returnTo" value={returnTo} />
                              <button
                                type="submit"
                                className="inline-flex items-center gap-2 rounded-xl border border-green-300 bg-white px-3 py-2 text-sm font-semibold text-green-700 hover:bg-green-50"
                              >
                                <CheckCircle2 className="h-4 w-4" />
                                Convert active
                              </button>
                            </form>
                            <form action={archiveLeadAction}>
                              <input type="hidden" name="clientId" value={selectedLead.id} />
                              <input type="hidden" name="returnTo" value={returnTo} />
                              <button
                                type="submit"
                                className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
                              >
                                <Archive className="h-4 w-4" />
                                Archive lead
                              </button>
                            </form>
                          </section>
                        </div>
                      ) : selectedFollowUp ? (
                        <div className="space-y-4 p-5">
                          <section className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                              Follow-up details
                            </p>
                            <h3 className="mt-2 text-lg font-semibold text-slate-950">
                              {activityLabel(selectedFollowUp.activity_type)}
                            </h3>
                            <p className="mt-2 text-sm leading-6 text-slate-700">
                              {selectedFollowUp.note || "No note was recorded."}
                            </p>
                          </section>
              
                          <section className="grid gap-3 sm:grid-cols-2">
                            <div className="rounded-2xl border border-orange-100 bg-[linear-gradient(135deg,#fff7ed_0%,#ffffff_100%)] p-4">
                              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-700">
                                Due
                              </p>
                              <p className="mt-2 text-sm font-medium text-slate-900">
                                {formatDateTime(selectedFollowUp.follow_up_due_at)}
                              </p>
                            </div>
                            <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4">
                              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
                                Completed
                              </p>
                              <p className="mt-2 text-sm font-medium text-slate-900">
                                {formatDateTime(selectedFollowUp.completed_at)}
                              </p>
                            </div>
                          </section>
              
                          <section className="rounded-2xl border border-sky-100 bg-sky-50/70 p-4">
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-700">
                              ARIA recommendation
                            </p>
                            <p className="mt-2 text-sm leading-6 text-slate-700">
                              Review the lead record before completing the follow-up so the
                              next action, outcome, and timing stay connected to the client
                              relationship.
                            </p>
                          </section>
                        </div>
                      ) : null}
                    </ResponsiveDetailPanel>
            ),
            document.body,
          )
        : null}
    </>
  );
}

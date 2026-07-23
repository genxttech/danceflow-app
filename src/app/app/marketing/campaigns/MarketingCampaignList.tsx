"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  CalendarClock,
  Mail,
  Megaphone,
  Send,
  Users,
} from "lucide-react";
import ResponsiveDetailPanel from "@/components/app/workspace/ResponsiveDetailPanel";
import type { CampaignRow } from "./page";

const audienceLabels: Record<string, string> = {
  all_active_clients: "All active clients",
  new_leads: "New leads",
  inactive_clients: "Inactive clients",
  event_attendees: "All event registrants",
  specific_event_registrants: "Specific event registrants",
  specific_event_checked_in: "Specific event checked-in attendees",
  clients_no_upcoming_lesson: "Clients with no upcoming lesson",
  low_package_credits: "Clients with low package credits",
};

function audienceLabel(value: string) {
  return audienceLabels[value] ?? value.replaceAll("_", " ");
}

function formatDate(value: string | null) {
  if (!value) return "Not sent";

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function campaignStatusMeta(status: string) {
  const normalized = status.trim().toLowerCase();

  switch (normalized) {
    case "sent":
      return {
        label: "Sent",
        badgeClass: "border-emerald-200 bg-emerald-50 text-emerald-800",
        cardClass: "border-emerald-100 hover:border-emerald-200",
        actionLabel: "View results",
      };
    case "scheduled":
      return {
        label: "Scheduled",
        badgeClass: "border-sky-200 bg-sky-50 text-sky-800",
        cardClass: "border-sky-100 hover:border-sky-200",
        actionLabel: "Review schedule",
      };
    case "failed":
      return {
        label: "Needs attention",
        badgeClass: "border-red-200 bg-red-50 text-red-700",
        cardClass: "border-red-200 bg-red-50/30 hover:border-red-300",
        actionLabel: "Resolve issue",
      };
    case "test":
    case "test_sent":
      return {
        label: "Test sent",
        badgeClass: "border-amber-200 bg-amber-50 text-amber-800",
        cardClass: "border-amber-100 hover:border-amber-200",
        actionLabel: "Review test",
      };
    default:
      return {
        label: "Draft",
        badgeClass: "border-violet-200 bg-violet-50 text-violet-800",
        cardClass: "border-orange-100 hover:border-violet-200",
        actionLabel: "Continue draft",
      };
  }
}

export default function MarketingCampaignList({
  campaigns,
}: {
  campaigns: CampaignRow[];
}) {
  const [selectedCampaign, setSelectedCampaign] =
    useState<CampaignRow | null>(null);

  const selectedStatus = selectedCampaign
    ? campaignStatusMeta(selectedCampaign.status)
    : null;

  return (
    <>
      <div className="space-y-3">
        {campaigns.map((campaign) => {
          const statusMeta = campaignStatusMeta(campaign.status);

          return (
            <button
              key={campaign.id}
              type="button"
              onClick={() => setSelectedCampaign(campaign)}
              className={`block w-full rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${statusMeta.cardClass}`}
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-[var(--brand-text)]">
                      {campaign.name}
                    </p>
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusMeta.badgeClass}`}
                    >
                      {statusMeta.label}
                    </span>
                  </div>

                  <p className="mt-2 text-sm font-medium text-slate-800">
                    {campaign.subject}
                  </p>

                  {campaign.preview_text ? (
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--brand-muted)]">
                      {campaign.preview_text}
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--brand-muted)]">
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">
                      {audienceLabel(campaign.audience_type)}
                    </span>
                    <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1">
                      Created {formatDate(campaign.created_at)}
                    </span>
                    {campaign.sent_at ? (
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-800">
                        Sent {formatDate(campaign.sent_at)}
                      </span>
                    ) : null}
                  </div>
                </div>

                <span className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2.5 text-sm font-bold text-white shadow-sm">
                  Review details
                  <ArrowRight className="h-4 w-4" />
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <ResponsiveDetailPanel
        open={Boolean(selectedCampaign)}
        title={selectedCampaign?.name ?? "Campaign details"}
        description={
          selectedCampaign && selectedStatus
            ? `${selectedStatus.label} campaign`
            : undefined
        }
        onClose={() => setSelectedCampaign(null)}
        footer={
          selectedCampaign && selectedStatus ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
              <button
                type="button"
                onClick={() => setSelectedCampaign(null)}
                className="rounded-xl border border-violet-200 bg-white px-4 py-2.5 text-sm font-semibold text-violet-800 hover:bg-violet-50"
              >
                Keep reviewing campaigns
              </button>
              <Link
                href={`/app/marketing/campaigns/${selectedCampaign.id}`}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-110"
              >
                {selectedStatus.actionLabel}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          ) : null
        }
      >
        {selectedCampaign && selectedStatus ? (
          <div className="space-y-4 p-5">
            <section className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <span className="rounded-xl bg-[linear-gradient(135deg,#ede9fe_0%,#ffedd5_100%)] p-2 text-violet-800 ring-1 ring-violet-200">
                  <Megaphone className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                    Campaign status
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${selectedStatus.badgeClass}`}
                    >
                      {selectedStatus.label}
                    </span>
                    <span className="text-sm text-slate-600">
                      Created {formatDate(selectedCampaign.created_at)}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-orange-100 bg-[linear-gradient(135deg,#fff7ed_0%,#faf5ff_100%)] p-4">
              <div className="flex items-start gap-3">
                <Mail className="mt-0.5 h-4 w-4 text-orange-700" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-700">
                    Message preview
                  </p>
                  <p className="mt-2 text-base font-semibold text-slate-950">
                    {selectedCampaign.subject}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-700">
                    {selectedCampaign.preview_text ||
                      "No inbox preview text has been added yet."}
                  </p>
                </div>
              </div>
            </section>

            <section className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
                <Users className="h-4 w-4 text-violet-700" />
                <p className="mt-3 text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
                  Audience
                </p>
                <p className="mt-2 text-sm font-medium text-slate-900">
                  {audienceLabel(selectedCampaign.audience_type)}
                </p>
              </div>

              <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4">
                {selectedCampaign.sent_at ? (
                  <Send className="h-4 w-4 text-emerald-700" />
                ) : (
                  <CalendarClock className="h-4 w-4 text-emerald-700" />
                )}
                <p className="mt-3 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
                  Delivery
                </p>
                <p className="mt-2 text-sm font-medium text-slate-900">
                  {selectedCampaign.sent_at
                    ? `Sent ${formatDate(selectedCampaign.sent_at)}`
                    : selectedStatus.label}
                </p>
              </div>
            </section>

            <section className="rounded-2xl border border-sky-100 bg-sky-50/70 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-700">
                Next action
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                Open the full campaign workspace to review the complete message,
                recipients, branding, test delivery, scheduling, sending, or
                results.
              </p>
            </section>
          </div>
        ) : null}
      </ResponsiveDetailPanel>
    </>
  );
}

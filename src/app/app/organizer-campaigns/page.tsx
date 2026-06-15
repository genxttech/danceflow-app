import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CalendarDays,
  CheckCircle2,
  Mail,
  Megaphone,
  Search,
  Ticket,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createOrganizerCampaignDraftAction } from "./actions";
import CampaignAIAssistant from "../marketing/campaigns/CampaignAIAssistant";

type SearchParams = Promise<{
  organizer?: string;
  audience?: string;
  event?: string;
  source?: string;
  name?: string;
  subject?: string;
  previewText?: string;
  bodyText?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  campaign_saved?: string;
  campaign_error?: string;
}>;

type OrganizerRow = {
  id: string;
  name: string;
  slug: string | null;
  active: boolean;
};

type EventRow = {
  id: string;
  name: string;
  start_date: string | null;
};

type OrganizerContactRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: string | null;
  total_paid_registrations: number | null;
};

type ContactRegistrationRow = {
  organizer_contact_id: string | null;
  payment_status: string | null;
  checked_in_at: string | null;
};

type OrganizerCampaignRow = {
  id: string;
  organizer_id: string;
  name: string;
  subject: string;
  preview_text: string | null;
  audience_type: string;
  audience_event_id: string | null;
  status: string;
  created_at: string;
  sent_at: string | null;
};

type AudiencePreview = {
  count: number;
  suppressed: number;
  sample: string[];
  label: string;
  description: string;
};


type AudienceGuidance = {
  title: string;
  intent: string;
  review: string[];
  risk: string;
};

function audienceGuidanceFor(audienceType: string, eventName: string | null | undefined): AudienceGuidance {
  const eventLabel = eventName || "the selected event";

  switch (audienceType) {
    case "specific_event_unpaid_pending":
      return {
        title: "ARIA audience guidance: unpaid / pending registrations",
        intent: `Use this when you need people registered for ${eventLabel} to finish payment or confirm their status.`,
        review: [
          "Review payment status before sending so already-paid attendees are not included by mistake.",
          "Keep the tone helpful and service-oriented, not punitive.",
          "Link to the event or registration details so the recipient has a clear next step.",
        ],
        risk: "Do not use this audience for general marketing; it is best for operational registration follow-up.",
      };
    case "specific_event_ticket_buyers":
      return {
        title: "ARIA audience guidance: paid event attendees",
        intent: `Use this for attendee updates, event reminders, and repeat-event announcements tied to ${eventLabel}.`,
        review: [
          "Confirm the message is relevant to people who paid for this event.",
          "Avoid refund or payment language unless the audience is specifically filtered for that purpose.",
          "Use a clear CTA such as event details, upcoming events, or feedback.",
        ],
        risk: "This audience may include people who paid but did not check in, so avoid wording that assumes everyone attended.",
      };
    case "specific_event_checked_in":
      return {
        title: "ARIA audience guidance: checked-in attendees",
        intent: `Use this for thank-you notes, feedback requests, and repeat-event invitations after ${eventLabel}.`,
        review: [
          "This is the safest post-event audience because it is based on check-in activity.",
          "Reference the event experience directly since these contacts were checked in.",
          "Consider asking for feedback or inviting them to a similar future event.",
        ],
        risk: "If check-in scanning was incomplete, this list may miss real attendees.",
      };
    case "specific_event_no_shows":
      return {
        title: "ARIA audience guidance: no-shows / not checked in",
        intent: `Use this when paid contacts for ${eventLabel} were not checked in and may need a careful follow-up.`,
        review: [
          "Use soft language because some attendees may have attended but were missed at check-in.",
          "Do not assume fault or absence unless check-in operations were fully reliable.",
          "Invite them to reply if the record is wrong or if they need help.",
        ],
        risk: "This audience is operationally sensitive; avoid language that sounds accusatory.",
      };
    case "specific_event_refunded":
      return {
        title: "ARIA audience guidance: refunded registrations",
        intent: `Use this for issue-resolution or goodwill follow-up connected to ${eventLabel}.`,
        review: [
          "Confirm the refund or issue status before sending.",
          "Keep the message focused on clarity, support, and resolution.",
          "Do not include promotional language unless the issue has been resolved.",
        ],
        risk: "Refunded contacts may be dissatisfied; use a service tone and avoid automated-sounding language.",
      };
    case "specific_event_registrants":
      return {
        title: "ARIA audience guidance: all event registrants",
        intent: `Use this for broad updates that apply to everyone registered for ${eventLabel}.`,
        review: [
          "Make sure the message applies to paid, pending, and unpaid registrations.",
          "Avoid language that assumes attendance or payment unless you choose a narrower audience.",
          "Use event details or support contact as the main CTA.",
        ],
        risk: "This is a broad event audience; use a narrower audience for payment, refund, or attendance-specific messages.",
      };
    default:
      return {
        title: "ARIA audience guidance",
        intent: "Use this audience when the message applies broadly to organizer contacts.",
        review: [
          "Confirm the audience matches the message purpose.",
          "Review unsubscribe and consent expectations before sending live campaigns.",
          "Keep the CTA aligned with the audience and event context.",
        ],
        risk: "Broad audiences should not receive event-specific operational messages unless they are relevant.",
      };
  }
}

const audienceOptions = [
  {
    key: "all_organizer_contacts",
    label: "All organizer contacts",
    description: "Every active contact captured from organizer-owned event registrations.",
    requiresEvent: false,
  },
  {
    key: "specific_event_registrants",
    label: "Specific event registrants",
    description: "Contacts attached to registrations for the selected event.",
    requiresEvent: true,
  },
  {
    key: "specific_event_ticket_buyers",
    label: "Paid event attendees",
    description: "Contacts with paid registrations for the selected event.",
    requiresEvent: true,
  },
  {
    key: "specific_event_unpaid_pending",
    label: "Unpaid / pending event registrations",
    description: "Contacts whose selected-event registration still needs payment or confirmation.",
    requiresEvent: true,
  },
  {
    key: "specific_event_checked_in",
    label: "Specific event checked-in attendees",
    description: "Contacts checked in for the selected event.",
    requiresEvent: true,
  },
  {
    key: "specific_event_no_shows",
    label: "No-shows / not checked in",
    description: "Paid event contacts that were not checked in for the selected event.",
    requiresEvent: true,
  },
  {
    key: "specific_event_refunded",
    label: "Refunded event registrations",
    description: "Contacts tied to refunded or partially refunded registrations for the selected event.",
    requiresEvent: true,
  },
  {
    key: "paid_registration_contacts",
    label: "Contacts with paid registrations",
    description: "Organizer contacts with at least one paid registration.",
    requiresEvent: false,
  },
];

const starterTemplates = [
  {
    key: "event-reminder",
    label: "Event reminder",
    name: "Upcoming event reminder",
    subject: "Reminder: your upcoming dance event",
    previewText: "We are looking forward to seeing you.",
    bodyText:
      "Hi,\n\nWe are looking forward to seeing you at the event. Please review the event details, arrival time, and any important updates before you arrive.\n\nReply to this email if you have any questions.",
    ctaLabel: "View event details",
  },
  {
    key: "post-event-follow-up",
    label: "Post-event follow-up",
    name: "Post-event thank you",
    subject: "Thank you for joining us",
    previewText: "We appreciate you being part of the event.",
    bodyText:
      "Hi,\n\nThank you for joining us. We appreciate you being part of the event and hope you had a great experience.\n\nKeep an eye out for future events and updates.",
    ctaLabel: "See upcoming events",
  },
];

function canViewOrganizerCampaigns(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;

  return [
    "studio_owner",
    "studio_admin",
    "front_desk",
    "organizer_owner",
    "organizer_admin",
    "organizer_staff",
  ].includes(role ?? "");
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function searchParamValue(value: string | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

function suggestedPreviewText(value: string, fallback: string) {
  const text = value.trim() || fallback;
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function contactName(contact: OrganizerContactRow) {
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
  return name || contact.email;
}

function uniqueContacts(contacts: OrganizerContactRow[]) {
  const seen = new Set<string>();
  const unique: OrganizerContactRow[] = [];

  for (const contact of contacts) {
    const key = contact.email.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(contact);
  }

  return unique;
}

async function buildAudiencePreview(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  organizerId: string;
  audienceType: string;
  eventId: string;
}): Promise<AudiencePreview> {
  const { supabase, organizerId, audienceType, eventId } = params;
  const option = audienceOptions.find((item) => item.key === audienceType) ?? audienceOptions[0];

  const { data: unsubscribes } = await supabase
    .from("organizer_marketing_unsubscribes")
    .select("email")
    .eq("organizer_id", organizerId);

  const unsubscribedEmails = new Set(
    (unsubscribes ?? [])
      .map((row) => String(row.email ?? "").trim().toLowerCase())
      .filter(Boolean),
  );

  let contacts: OrganizerContactRow[] = [];

  if (audienceType === "all_organizer_contacts") {
    const { data, error } = await supabase
      .from("organizer_contacts")
      .select("id, email, first_name, last_name, status, total_paid_registrations")
      .eq("organizer_id", organizerId)
      .eq("status", "active")
      .order("last_seen_at", { ascending: false })
      .limit(5000);

    if (error) {
      throw new Error(`Failed to preview organizer contacts: ${error.message}`);
    }

    contacts = (data ?? []) as OrganizerContactRow[];
  } else if (audienceType === "paid_registration_contacts") {
    const { data, error } = await supabase
      .from("organizer_contacts")
      .select("id, email, first_name, last_name, status, total_paid_registrations")
      .eq("organizer_id", organizerId)
      .eq("status", "active")
      .gt("total_paid_registrations", 0)
      .order("last_seen_at", { ascending: false })
      .limit(5000);

    if (error) {
      throw new Error(`Failed to preview paid organizer contacts: ${error.message}`);
    }

    contacts = (data ?? []) as OrganizerContactRow[];
  } else if (eventId) {
    let registrationsQuery = supabase
      .from("organizer_contact_registrations")
      .select("organizer_contact_id, payment_status, checked_in_at")
      .eq("organizer_id", organizerId)
      .eq("event_id", eventId)
      .limit(10000);

    if (audienceType === "specific_event_ticket_buyers") {
      registrationsQuery = registrationsQuery.eq("payment_status", "paid");
    }

    if (audienceType === "specific_event_unpaid_pending") {
      registrationsQuery = registrationsQuery.in("payment_status", [
        "unpaid",
        "pending",
        "requires_payment",
        "failed",
      ]);
    }

    if (audienceType === "specific_event_checked_in") {
      registrationsQuery = registrationsQuery.not("checked_in_at", "is", null);
    }

    if (audienceType === "specific_event_no_shows") {
      registrationsQuery = registrationsQuery.eq("payment_status", "paid").is("checked_in_at", null);
    }

    if (audienceType === "specific_event_refunded") {
      registrationsQuery = registrationsQuery.in("payment_status", [
        "refunded",
        "partially_refunded",
      ]);
    }

    const { data: registrations, error: registrationsError } = await registrationsQuery;

    if (registrationsError) {
      throw new Error(`Failed to preview event audience: ${registrationsError.message}`);
    }

    const contactIds = Array.from(
      new Set(
        ((registrations ?? []) as ContactRegistrationRow[])
          .map((row) => row.organizer_contact_id)
          .filter(Boolean),
      ),
    ) as string[];

    if (contactIds.length > 0) {
      const { data, error } = await supabase
        .from("organizer_contacts")
        .select("id, email, first_name, last_name, status, total_paid_registrations")
        .eq("organizer_id", organizerId)
        .eq("status", "active")
        .in("id", contactIds)
        .limit(5000);

      if (error) {
        throw new Error(`Failed to load event audience contacts: ${error.message}`);
      }

      contacts = (data ?? []) as OrganizerContactRow[];
    }
  }

  const dedupedContacts = uniqueContacts(contacts);
  const suppressed = dedupedContacts.filter((contact) =>
    unsubscribedEmails.has(contact.email.trim().toLowerCase()),
  ).length;
  const deliverable = dedupedContacts.filter(
    (contact) => !unsubscribedEmails.has(contact.email.trim().toLowerCase()),
  );

  return {
    label: option.label,
    description: option.description,
    count: deliverable.length,
    suppressed,
    sample: deliverable.slice(0, 8).map(contactName),
  };
}

function StatCard({
  label,
  value,
  helper,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  helper?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{value}</p>
          {helper ? <p className="mt-2 text-sm text-slate-500">{helper}</p> : null}
        </div>
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

export default async function OrganizerCampaignsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const resolvedSearchParams = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  if (!canViewOrganizerCampaigns(context.studioRole, context.isPlatformAdmin)) {
    redirect("/app");
  }

  const { data: organizers, error: organizersError } = await supabase
    .from("organizers")
    .select("id, name, slug, active")
    .eq("studio_id", context.studioId)
    .order("name", { ascending: true });

  if (organizersError) {
    throw new Error(`Failed to load organizers: ${organizersError.message}`);
  }

  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const selectedOrganizerId =
    resolvedSearchParams.organizer && typedOrganizers.some((item) => item.id === resolvedSearchParams.organizer)
      ? resolvedSearchParams.organizer
      : typedOrganizers[0]?.id ?? "";

  const selectedAudience = audienceOptions.some((item) => item.key === resolvedSearchParams.audience)
    ? String(resolvedSearchParams.audience)
    : "all_organizer_contacts";
  const selectedEventId = resolvedSearchParams.event ?? "";

  const [{ data: events, error: eventsError }, { data: campaigns, error: campaignsError }] =
    await Promise.all([
      selectedOrganizerId
        ? supabase
            .from("events")
            .select("id, name, start_date")
            .eq("organizer_id", selectedOrganizerId)
            .order("start_date", { ascending: false })
            .limit(100)
        : Promise.resolve({ data: [], error: null }),
      selectedOrganizerId
        ? supabase
            .from("organizer_marketing_campaigns")
            .select("id, organizer_id, name, subject, preview_text, audience_type, audience_event_id, status, created_at, sent_at")
            .eq("organizer_id", selectedOrganizerId)
            .order("created_at", { ascending: false })
            .limit(25)
        : Promise.resolve({ data: [], error: null }),
    ]);

  if (eventsError) {
    throw new Error(`Failed to load organizer events: ${eventsError.message}`);
  }

  if (campaignsError) {
    throw new Error(`Failed to load organizer campaigns: ${campaignsError.message}`);
  }

  const typedEvents = (events ?? []) as EventRow[];
  const typedCampaigns = (campaigns ?? []) as OrganizerCampaignRow[];
  const selectedOrganizer = typedOrganizers.find((item) => item.id === selectedOrganizerId) ?? null;
  const selectedAudienceOption = audienceOptions.find((item) => item.key === selectedAudience) ?? audienceOptions[0];
  const validSelectedEventId = typedEvents.some((event) => event.id === selectedEventId)
    ? selectedEventId
    : "";
  const selectedEvent = typedEvents.find((event) => event.id === validSelectedEventId) ?? null;

  const preview = selectedOrganizerId
    ? await buildAudiencePreview({
        supabase,
        organizerId: selectedOrganizerId,
        audienceType: selectedAudience,
        eventId: validSelectedEventId,
      })
    : {
        label: "No organizer selected",
        description: "Create or select an organizer before previewing contacts.",
        count: 0,
        suppressed: 0,
        sample: [],
      };

  const ariaAudienceGuidance = audienceGuidanceFor(selectedAudience, selectedEvent?.name);

  const draftCount = typedCampaigns.filter((campaign) => campaign.status === "draft").length;
  const sentCount = typedCampaigns.filter((campaign) => campaign.status === "sent").length;
  const eventAudienceNeedsEvent = selectedAudienceOption.requiresEvent && !validSelectedEventId;

  const ariaPrefillSource = resolvedSearchParams.source === "aria-follow-up";
  const prefillName = searchParamValue(resolvedSearchParams.name);
  const prefillSubject = searchParamValue(resolvedSearchParams.subject);
  const prefillPreviewText = searchParamValue(resolvedSearchParams.previewText);
  const prefillBodyText = searchParamValue(resolvedSearchParams.bodyText);
  const prefillCtaLabel = searchParamValue(resolvedSearchParams.ctaLabel);
  const prefillCtaUrl = searchParamValue(resolvedSearchParams.ctaUrl);

  const campaignNameDefault =
    prefillName ||
    (selectedEvent ? `Follow-up: ${selectedEvent.name}` : "");
  const subjectDefault = prefillSubject;
  const previewTextDefault = suggestedPreviewText(
    prefillPreviewText,
    selectedEvent ? `A quick update about ${selectedEvent.name}.` : "A quick event update from the organizer.",
  );
  const bodyTextDefault = prefillBodyText;
  const ctaLabelDefault = prefillCtaLabel || (selectedEvent ? "View event details" : "");
  const ctaUrlDefault = prefillCtaUrl;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Organizer Marketing
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Organizer Campaigns
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Create safe organizer-scoped campaign drafts using contacts captured from organizer-owned event registrations. Live sending comes after audience previews and consent handling are stable.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/organizer-contacts"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Organizer Contacts
              </Link>
              <Link
                href="/app/events"
                className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-primary)] shadow-sm hover:bg-white/90"
              >
                Events
              </Link>
            </div>
          </div>
        </div>
      </section>

      {resolvedSearchParams.campaign_saved ? (
        <div className="rounded-3xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-800">
          Organizer campaign draft saved.
        </div>
      ) : null}

      {resolvedSearchParams.campaign_error ? (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">
          Campaign action failed: {resolvedSearchParams.campaign_error.replaceAll("_", " ")}.
        </div>
      ) : null}

      {ariaPrefillSource ? (
        <div className="rounded-3xl border border-[#E9D5FF] bg-[#F9F1FF] px-5 py-4 text-sm leading-6 text-[#4D1F47]">
          <span className="font-semibold">ARIA prefilled this campaign draft.</span>{" "}
          Review the audience, subject, and message before saving. Nothing is sent automatically.
        </div>
      ) : null}

      {ariaPrefillSource ? (
        <section className="rounded-[28px] border border-[#E9D5FF] bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                ARIA audience guidance
              </p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">
                {ariaAudienceGuidance.title}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {ariaAudienceGuidance.intent}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Current preview
              </p>
              <p className="mt-1 text-2xl font-semibold text-slate-950">
                {eventAudienceNeedsEvent ? "Select event" : preview.count}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {preview.suppressed} suppressed by organizer unsubscribe rules
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="rounded-3xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-950">Review before saving</p>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
                {ariaAudienceGuidance.review.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#7C2D92]" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
              <p className="font-semibold">Audience safety note</p>
              <p className="mt-2">{ariaAudienceGuidance.risk}</p>
            </div>
          </div>
        </section>
      ) : null}

      <section className="grid gap-4 md:grid-cols-4">
        <StatCard label="Organizer" value={selectedOrganizer?.name ?? "None"} helper="Current campaign workspace" icon={Megaphone} />
        <StatCard label="Preview audience" value={eventAudienceNeedsEvent ? "Select event" : preview.count} helper={`${preview.suppressed} suppressed`} icon={Users} />
        <StatCard label="Drafts" value={draftCount} helper="Saved organizer drafts" icon={Mail} />
        <StatCard label="Sent" value={sentCount} helper="Campaigns sent" icon={CheckCircle2} />
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-950">Create organizer campaign draft</h2>
              <p className="mt-1 text-sm text-slate-500">
                Use the preview to verify the audience before saving.
              </p>
            </div>
          </div>

          <form action={createOrganizerCampaignDraftAction} className="mt-5 space-y-5">
            {ariaPrefillSource ? (
              <input type="hidden" name="source" value="aria-follow-up" />
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm font-medium text-slate-700">
                Organizer
                <select
                  name="organizerId"
                  defaultValue={selectedOrganizerId}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                  required
                >
                  {typedOrganizers.map((organizer) => (
                    <option key={organizer.id} value={organizer.id}>
                      {organizer.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                Audience
                <select
                  name="audienceType"
                  defaultValue={selectedAudience}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                >
                  {audienceOptions.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="space-y-2 text-sm font-medium text-slate-700">
              Event for event-based audiences
              <select
                name="audienceEventId"
                defaultValue={validSelectedEventId}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
              >
                <option value="">No event selected</option>
                {typedEvents.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.name}{event.start_date ? ` · ${formatDate(event.start_date)}` : ""}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm font-medium text-slate-700">
                Campaign name
                <input
                  name="name"
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                  placeholder="Post-event thank you"
                  defaultValue={campaignNameDefault}
                  required
                />
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                Subject
                <input
                  name="subject"
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                  placeholder="Thank you for joining us"
                  defaultValue={subjectDefault}
                  required
                />
              </label>
            </div>

            <label className="space-y-2 text-sm font-medium text-slate-700">
              Preview text
              <input
                name="previewText"
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                placeholder="A quick event update from the organizer."
                defaultValue={previewTextDefault}
              />
            </label>

            <label className="space-y-2 text-sm font-medium text-slate-700">
              Message body
              <textarea
                name="bodyText"
                rows={8}
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm leading-6 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                placeholder="Hi,\n\nThanks for joining us..."
                defaultValue={bodyTextDefault}
                required
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm font-medium text-slate-700">
                CTA label
                <input
                  name="ctaLabel"
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                  placeholder="View event details"
                  defaultValue={ctaLabelDefault}
                />
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                CTA URL
                <input
                  name="ctaUrl"
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                  placeholder="https://idanceflow.com/events/..."
                  defaultValue={ctaUrlDefault}
                />
              </label>
            </div>

            <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
              Consent reminder: only send organizer campaigns to people the organizer is allowed to email. DanceFlow will use organizer unsubscribes for future live sends.
            </div>

            <button
              type="submit"
              disabled={!selectedOrganizerId || eventAudienceNeedsEvent}
              className="rounded-2xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[var(--brand-primary-dark)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save draft
            </button>
          </form>
        </div>

        <aside className="space-y-6">
          <form className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm" method="get">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <Search className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-950">Audience preview</h2>
                <p className="text-sm text-slate-500">Check who would receive this campaign.</p>
              </div>
            </div>

            <div className="mt-5 space-y-4">
              <label className="space-y-2 text-sm font-medium text-slate-700">
                Organizer
                <select name="organizer" defaultValue={selectedOrganizerId} className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
                  {typedOrganizers.map((organizer) => (
                    <option key={organizer.id} value={organizer.id}>{organizer.name}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-2 text-sm font-medium text-slate-700">
                Audience
                <select name="audience" defaultValue={selectedAudience} className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
                  {audienceOptions.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-2 text-sm font-medium text-slate-700">
                Event
                <select name="event" defaultValue={validSelectedEventId} className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
                  <option value="">No event selected</option>
                  {typedEvents.map((event) => (
                    <option key={event.id} value={event.id}>{event.name}{event.start_date ? ` · ${formatDate(event.start_date)}` : ""}</option>
                  ))}
                </select>
              </label>
              <button className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                Refresh preview
              </button>
            </div>

            <div className="mt-5 rounded-3xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-950">{preview.label}</p>
              <p className="mt-1 text-sm leading-6 text-slate-600">{preview.description}</p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-white p-3">
                  <p className="text-xs text-slate-500">Deliverable</p>
                  <p className="text-2xl font-semibold text-slate-950">{eventAudienceNeedsEvent ? "—" : preview.count}</p>
                </div>
                <div className="rounded-2xl bg-white p-3">
                  <p className="text-xs text-slate-500">Suppressed</p>
                  <p className="text-2xl font-semibold text-slate-950">{preview.suppressed}</p>
                </div>
              </div>
              {eventAudienceNeedsEvent ? (
                <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  Select an event to preview this audience.
                </p>
              ) : preview.sample.length > 0 ? (
                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sample contacts</p>
                  <ul className="mt-2 space-y-1 text-sm text-slate-700">
                    {preview.sample.map((sample) => (
                      <li key={sample}>• {sample}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="mt-4 text-sm text-slate-500">No matching contacts yet.</p>
              )}
            </div>
          </form>

          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-950">Starter templates</h2>
            <div className="mt-4 space-y-3">
              {starterTemplates.map((template) => (
                <div key={template.key} className="rounded-3xl border border-slate-100 bg-slate-50 p-4">
                  <p className="font-medium text-slate-950">{template.label}</p>
                  <p className="mt-1 text-sm text-slate-500">Subject: {template.subject}</p>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">Recent organizer campaign drafts</h2>
            <p className="mt-1 text-sm text-slate-500">Drafts are saved separately from studio marketing campaigns.</p>
          </div>
          <Link href="/app/organizer-contacts" className="text-sm font-semibold text-[var(--brand-primary)] hover:underline">
            View contacts
          </Link>
        </div>

        {typedCampaigns.length === 0 ? (
          <div className="mt-5 rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
            <Mail className="mx-auto h-8 w-8 text-slate-400" />
            <p className="mt-3 font-medium text-slate-900">No organizer campaigns yet</p>
            <p className="mt-1 text-sm text-slate-500">Create the first draft above after previewing an audience.</p>
          </div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-3xl border border-slate-100">
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Campaign</th>
                  <th className="px-4 py-3">Audience</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {typedCampaigns.map((campaign) => {
                  const audience = audienceOptions.find((item) => item.key === campaign.audience_type);
                  return (
                    <tr key={campaign.id}>
                      <td className="px-4 py-4">
                        <Link href={`/app/organizer-campaigns/${campaign.id}`} className="font-medium text-[var(--brand-primary)] hover:underline">
                          {campaign.name}
                        </Link>
                        <p className="mt-1 text-slate-500">{campaign.subject}</p>
                      </td>
                      <td className="px-4 py-4 text-slate-600">{audience?.label ?? campaign.audience_type}</td>
                      <td className="px-4 py-4">
                        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                          {campaign.status}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-slate-500">{formatDateTime(campaign.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <Ticket className="h-5 w-5 text-[var(--brand-primary)]" />
          <h3 className="mt-3 font-semibold text-slate-950">Event-based audiences</h3>
          <p className="mt-2 text-sm leading-6 text-slate-500">Target registrants, paid ticket buyers, checked-in attendees, or no-shows for one organizer-owned event.</p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <CalendarDays className="h-5 w-5 text-[var(--brand-primary)]" />
          <h3 className="mt-3 font-semibold text-slate-950">Reminder-ready foundation</h3>
          <p className="mt-2 text-sm leading-6 text-slate-500">Drafts prepare the path for event reminders, post-event follow-ups, and future organizer automations.</p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <Users className="h-5 w-5 text-[var(--brand-primary)]" />
          <h3 className="mt-3 font-semibold text-slate-950">Separate from studio CRM</h3>
          <p className="mt-2 text-sm leading-6 text-slate-500">Organizer contacts stay organizer-scoped so event marketing does not pollute studio client records.</p>
        </div>
      </section>
    </div>
  );
}


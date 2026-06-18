import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  Mail,
  Send,
  ShieldCheck,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  generateOrganizerCampaignRecipientsAction,
  sendOrganizerCampaignAction,
  sendOrganizerCampaignTestEmailAction,
  updateOrganizerCampaignDraftAction,
} from "./actions";
import CampaignAIAssistant from "../../marketing/campaigns/CampaignAIAssistant";

type Params = Promise<{
  id: string;
}>;

type SearchParams = Promise<{
  campaign_saved?: string;
  test_sent?: string;
  recipients_generated?: string;
  campaign_sent?: string;
  campaign_error?: string;
  recipient_status?: string;
  source?: string;
}>;

type OrganizerCampaignRow = {
  id: string;
  organizer_id: string;
  name: string;
  subject: string;
  preview_text: string | null;
  body_text: string;
  cta_label: string | null;
  cta_url: string | null;
  audience_type: string;
  audience_event_id: string | null;
  status: string;
  created_at: string;
  updated_at: string | null;
  sent_at: string | null;
};

type OrganizerRow = {
  id: string;
  name: string;
  slug: string | null;
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

type RecipientRow = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  error_message: string | null;
  unsubscribe_token?: string | null;
  sent_at: string | null;
  created_at: string;
};

type AudiencePreview = {
  count: number;
  suppressed: number;
  total: number;
  sample: string[];
  label: string;
  description: string;
};

const audienceOptions = [
  {
    key: "all_organizer_contacts",
    label: "All organizer contacts",
    description:
      "Every active contact captured from organizer-owned event registrations.",
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
    label: "Specific event ticket buyers",
    description: "Contacts with paid registrations for the selected event.",
    requiresEvent: true,
  },
  {
    key: "specific_event_unpaid_pending",
    label: "Specific event unpaid / pending",
    description: "Contacts with unpaid or pending registrations for the selected event.",
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
    label: "Specific event no-shows",
    description:
      "Paid event contacts that were not checked in for the selected event.",
    requiresEvent: true,
  },
  {
    key: "specific_event_registered_not_checked_in",
    label: "Specific event not checked in",
    description:
      "Contacts registered for the selected event who do not have a check-in recorded.",
    requiresEvent: true,
  },
  {
    key: "specific_event_refunded",
    label: "Specific event refunded",
    description: "Contacts with refunded registrations for the selected event.",
    requiresEvent: true,
  },
  {
    key: "paid_registration_contacts",
    label: "Contacts with paid registrations",
    description: "Organizer contacts with at least one paid registration.",
    requiresEvent: false,
  },
];

type CampaignReviewGuidance = {
  title: string;
  intent: string;
  review: string[];
  risk: string;
  nextSteps: string[];
};

function campaignReviewGuidanceFor(
  audienceType: string,
  eventName: string | null | undefined,
): CampaignReviewGuidance {
  const eventLabel = eventName || "the selected event";

  switch (audienceType) {
    case "specific_event_registered_not_checked_in":
      return {
        title: "Review not-checked-in follow-up",
        intent: `This draft is meant for contacts registered for ${eventLabel} who do not have a check-in recorded.`,
        review: [
          "Use careful wording because check-in may have been missed at the door.",
          "Avoid saying they definitely did not attend unless your check-in process was complete.",
          "Give the recipient a simple way to reply if the record is wrong.",
        ],
        risk: "Not-checked-in audiences depend on check-in accuracy. Use soft language unless the door scan was complete.",
        nextSteps: [
          "Preview the not-checked-in audience count.",
          "Send yourself a test email first.",
          "Use paid no-shows if you only want paid registrations without check-in.",
        ],
      };
    case "specific_event_no_shows":
      return {
        title: "Review no-show language before sending",
        intent: `This draft is meant for paid contacts who were not checked in for ${eventLabel}.`,
        review: [
          "Use soft wording because some people may have attended but were missed at check-in.",
          "Avoid implying fault or absence unless check-in scanning was complete.",
          "Give the recipient a simple way to reply if the record is wrong.",
        ],
        risk: "No-show campaigns are operationally sensitive. Review the list before preparing recipients.",
        nextSteps: [
          "Preview the audience count before generating recipients.",
          "Send yourself a test email first.",
          "Check failed or suppressed recipients before sending live.",
        ],
      };
    case "specific_event_unpaid_pending":
      return {
        title: "Review payment follow-up tone",
        intent: `This draft is meant for unpaid or pending registrations tied to ${eventLabel}.`,
        review: [
          "Keep the message helpful and service-oriented, not punitive.",
          "Make the payment or confirmation next step obvious.",
          "Preview the audience after saving to avoid contacting already-paid attendees.",
        ],
        risk: "Payment follow-ups should be treated as operational reminders, not broad marketing campaigns.",
        nextSteps: [
          "Preview the unpaid/pending audience.",
          "Verify the CTA URL points to the right event or registration path.",
          "Send a test email before preparing recipients.",
        ],
      };
    case "specific_event_checked_in":
      return {
        title: "Good fit for post-event thank-you",
        intent: `This draft is aimed at contacts checked in for ${eventLabel}.`,
        review: [
          "It is safe to reference the event experience for checked-in attendees.",
          "Consider asking for feedback or linking to the next similar event.",
          "Make sure the CTA fits a post-event thank-you or repeat-event message.",
        ],
        risk: "If check-in scanning was incomplete, some actual attendees may be missing from this audience.",
        nextSteps: [
          "Preview the checked-in audience count.",
          "Send a test email to confirm formatting.",
          "Prepare recipients only after reviewing the audience preview.",
        ],
      };
    case "specific_event_refunded":
      return {
        title: "Use service-first refund follow-up",
        intent: `This draft is meant for refunded registrations tied to ${eventLabel}.`,
        review: [
          "Confirm refund or issue status before sending.",
          "Keep the tone focused on clarity, support, and resolution.",
          "Avoid promotional language unless the issue has been resolved.",
        ],
        risk: "Refunded contacts may be dissatisfied, so review carefully before sending.",
        nextSteps: [
          "Preview the refunded audience.",
          "Send a test email.",
          "Review any replies manually after sending.",
        ],
      };
    case "specific_event_ticket_buyers":
      return {
        title: "Good fit for paid attendee updates",
        intent: `This draft targets paid registrations for ${eventLabel}.`,
        review: [
          "Avoid assuming everyone attended unless you choose checked-in attendees instead.",
          "Use this for reminders, event updates, or repeat-event invitations.",
          "Check the CTA and event context before preparing recipients.",
        ],
        risk: "Paid buyers can include no-shows, so attendance-specific wording may be inaccurate.",
        nextSteps: [
          "Preview the paid attendee audience.",
          "Use checked-in attendees for post-event experience language.",
          "Send a test email before live send.",
        ],
      };
    case "specific_event_registrants":
      return {
        title: "Broad event audience review",
        intent: `This draft targets all registrations for ${eventLabel}.`,
        review: [
          "Make sure the message applies to paid, pending, and unpaid registrations.",
          "Avoid wording that assumes payment or attendance.",
          "Use a narrower audience for payment, refund, or no-show follow-up.",
        ],
        risk: "This audience is broad. Narrow it when the message is status-specific.",
        nextSteps: [
          "Preview the audience count.",
          "Confirm the message applies to all registrants.",
          "Send a test email before generating recipients.",
        ],
      };
    default:
      return {
        title: "Organizer campaign review",
        intent: "Review audience, message, and consent expectations before sending.",
        review: [
          "Confirm the audience matches the message purpose.",
          "Review the subject, preview text, and CTA.",
          "Use a test email before preparing recipients.",
        ],
        risk: "Broad organizer audiences should not receive event-specific operational messages unless relevant.",
        nextSteps: [
          "Preview the audience.",
          "Send yourself a test email.",
          "Prepare recipients only after review.",
        ],
      };
  }
}


function canViewOrganizerCampaigns(
  role: string | null | undefined,
  isPlatformAdminRole: boolean,
) {
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

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function normalizeEmail(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function contactName(contact: OrganizerContactRow) {
  const name = [contact.first_name, contact.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || contact.email;
}

function uniqueContacts(contacts: OrganizerContactRow[]) {
  const seen = new Set<string>();
  const unique: OrganizerContactRow[] = [];

  for (const contact of contacts) {
    const key = normalizeEmail(contact.email);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(contact);
  }

  return unique;
}

function normalizedRegistrationStatus(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function isPaidRegistrationStatus(value: string | null | undefined) {
  const status = normalizedRegistrationStatus(value);
  return ["paid", "succeeded", "complete", "completed"].includes(status);
}

function isUnpaidOrPendingRegistrationStatus(value: string | null | undefined) {
  const status = normalizedRegistrationStatus(value);
  return [
    "",
    "unpaid",
    "pending",
    "open",
    "requires_payment",
    "requires_payment_method",
    "processing",
    "incomplete",
  ].includes(status);
}

function isRefundedRegistrationStatus(value: string | null | undefined) {
  const status = normalizedRegistrationStatus(value);
  return ["refunded", "partially_refunded", "refund_pending"].includes(status);
}

function registrationMatchesAudience(
  registration: ContactRegistrationRow,
  audienceType: string,
) {
  switch (audienceType) {
    case "specific_event_ticket_buyers":
      return isPaidRegistrationStatus(registration.payment_status);
    case "specific_event_unpaid_pending":
      return isUnpaidOrPendingRegistrationStatus(registration.payment_status);
    case "specific_event_checked_in":
      return Boolean(registration.checked_in_at);
    case "specific_event_no_shows":
      return (
        isPaidRegistrationStatus(registration.payment_status) &&
        !registration.checked_in_at
      );
    case "specific_event_registered_not_checked_in":
      return !registration.checked_in_at;
    case "specific_event_refunded":
      return isRefundedRegistrationStatus(registration.payment_status);
    default:
      return true;
  }
}

function statusBadgeClass(status: string) {
  switch (String(status ?? "draft").toLowerCase()) {
    case "sent":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "sending":
    case "scheduled":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "failed":
    case "cancelled":
      return "border-rose-200 bg-rose-50 text-rose-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function countRecipientStatuses(recipients: RecipientRow[]) {
  return recipients.reduce(
    (totals, recipient) => {
      const status = String(recipient.status ?? "pending").toLowerCase();
      if (status === "sent") totals.sent += 1;
      else if (status === "failed") totals.failed += 1;
      else if (status === "unsubscribed") totals.unsubscribed += 1;
      else if (status === "skipped") totals.skipped += 1;
      else totals.pending += 1;
      return totals;
    },
    { pending: 0, sent: 0, failed: 0, skipped: 0, unsubscribed: 0 },
  );
}

async function buildAudiencePreview(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  organizerId: string;
  audienceType: string;
  eventId: string | null;
}): Promise<AudiencePreview> {
  const { supabase, organizerId, audienceType, eventId } = params;
  const option =
    audienceOptions.find((item) => item.key === audienceType) ??
    audienceOptions[0];

  if (option.requiresEvent && !eventId) {
    return {
      label: option.label,
      description: "Select an event before previewing this audience.",
      count: 0,
      suppressed: 0,
      total: 0,
      sample: [],
    };
  }

  const { data: unsubscribes } = await supabase
    .from("organizer_marketing_unsubscribes")
    .select("email")
    .eq("organizer_id", organizerId);

  const unsubscribedEmails = new Set(
    (unsubscribes ?? [])
      .map((row) => normalizeEmail(row.email))
      .filter(Boolean),
  );

  let contacts: OrganizerContactRow[] = [];

  if (audienceType === "all_organizer_contacts") {
    const { data, error } = await supabase
      .from("organizer_contacts")
      .select(
        "id, email, first_name, last_name, status, total_paid_registrations",
      )
      .eq("organizer_id", organizerId)
      .eq("status", "active")
      .order("last_seen_at", { ascending: false })
      .limit(5000);

    if (error)
      throw new Error(`Failed to preview organizer contacts: ${error.message}`);
    contacts = (data ?? []) as OrganizerContactRow[];
  } else if (audienceType === "paid_registration_contacts") {
    const { data, error } = await supabase
      .from("organizer_contacts")
      .select(
        "id, email, first_name, last_name, status, total_paid_registrations",
      )
      .eq("organizer_id", organizerId)
      .eq("status", "active")
      .gt("total_paid_registrations", 0)
      .order("last_seen_at", { ascending: false })
      .limit(5000);

    if (error)
      throw new Error(
        `Failed to preview paid organizer contacts: ${error.message}`,
      );
    contacts = (data ?? []) as OrganizerContactRow[];
  } else if (eventId) {
    let registrationsQuery = supabase
      .from("organizer_contact_registrations")
      .select("organizer_contact_id, payment_status, checked_in_at")
      .eq("organizer_id", organizerId)
      .eq("event_id", eventId)
      .limit(10000);

    const { data: registrations, error: registrationsError } =
      await registrationsQuery;
    if (registrationsError) {
      throw new Error(
        `Failed to preview event audience: ${registrationsError.message}`,
      );
    }

    const matchingRegistrations = ((registrations ?? []) as ContactRegistrationRow[])
      .filter((registration) => registrationMatchesAudience(registration, audienceType));

    const contactIds = Array.from(
      new Set(
        matchingRegistrations
          .map((row) => row.organizer_contact_id)
          .filter(Boolean),
      ),
    ) as string[];

    if (contactIds.length > 0) {
      const { data, error } = await supabase
        .from("organizer_contacts")
        .select(
          "id, email, first_name, last_name, status, total_paid_registrations",
        )
        .eq("organizer_id", organizerId)
        .eq("status", "active")
        .in("id", contactIds)
        .limit(5000);

      if (error)
        throw new Error(
          `Failed to load event audience contacts: ${error.message}`,
        );
      contacts = (data ?? []) as OrganizerContactRow[];
    }
  }

  const dedupedContacts = uniqueContacts(contacts);
  const deliverable = dedupedContacts.filter(
    (contact) => !unsubscribedEmails.has(normalizeEmail(contact.email)),
  );
  const suppressed = dedupedContacts.length - deliverable.length;

  return {
    label: option.label,
    description: option.description,
    count: deliverable.length,
    suppressed,
    total: dedupedContacts.length,
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
  helper: string;
  icon: LucideIcon;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <span className="rounded-2xl bg-[var(--brand-primary-soft)] p-2 text-[var(--brand-primary)]">
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
        {value}
      </p>
      <p className="mt-1 text-sm text-slate-500">{helper}</p>
    </div>
  );
}

export default async function OrganizerCampaignDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const [{ id }, resolvedSearchParams] = await Promise.all([
    params,
    searchParams,
  ]);
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canViewOrganizerCampaigns(context.studioRole, context.isPlatformAdmin)) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-950">
          Organizer campaigns unavailable
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          Your current role does not have access to organizer campaigns.
        </p>
      </div>
    );
  }

  const { data: campaignData, error: campaignError } = await supabase
    .from("organizer_marketing_campaigns")
    .select(
      "id, organizer_id, name, subject, preview_text, body_text, cta_label, cta_url, audience_type, audience_event_id, status, created_at, updated_at, sent_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (campaignError || !campaignData) {
    console.error("Failed to load organizer campaign detail", campaignError);
    notFound();
  }

  const campaign = campaignData as OrganizerCampaignRow;

  const [
    { data: organizerData },
    { data: eventsData },
    { data: recipientsData },
  ] = await Promise.all([
    supabase
      .from("organizers")
      .select("id, name, slug")
      .eq("id", campaign.organizer_id)
      .maybeSingle(),
    supabase
      .from("events")
      .select("id, name, start_date")
      .eq("organizer_id", campaign.organizer_id)
      .order("start_date", { ascending: false })
      .limit(200),
    supabase
      .from("organizer_marketing_campaign_recipients")
      .select(
        "id, email, name, status, error_message, unsubscribe_token, sent_at, created_at",
      )
      .eq("campaign_id", campaign.id)
      .eq("organizer_id", campaign.organizer_id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const organizer = organizerData as OrganizerRow | null;
  const events = (eventsData ?? []) as EventRow[];
  const recipients = (recipientsData ?? []) as RecipientRow[];
  const recipientTotals = countRecipientStatuses(recipients);

  let preview: AudiencePreview;
  try {
    preview = await buildAudiencePreview({
      supabase,
      organizerId: campaign.organizer_id,
      audienceType: campaign.audience_type,
      eventId: campaign.audience_event_id,
    });
  } catch (error) {
    console.error("Failed to build organizer campaign audience preview", error);
    preview = {
      label: "Audience preview unavailable",
      description: "DanceFlow could not preview this audience right now.",
      count: 0,
      suppressed: 0,
      total: 0,
      sample: [],
    };
  }

  const selectedAudience =
    audienceOptions.find((option) => option.key === campaign.audience_type) ??
    audienceOptions[0];
  const eventBasedAudienceOptions = audienceOptions.filter((option) => option.requiresEvent);
  const broadAudienceOptions = audienceOptions.filter((option) => !option.requiresEvent);
  const selectedEvent = events.find((event) => event.id === campaign.audience_event_id) ?? null;
  const selectedReviewGuidance = campaignReviewGuidanceFor(
    campaign.audience_type,
    selectedEvent?.name,
  );
  const isAriaGeneratedDraft = resolvedSearchParams.source === "aria-follow-up";
  const shouldShowCampaignReview = isAriaGeneratedDraft || Boolean(campaign.audience_event_id);
  const recipientsPrepared = recipients.length > 0;
  const ariaDraftContext = isAriaGeneratedDraft
    ? {
        label: selectedEvent
          ? `ARIA follow-up for ${selectedEvent.name}`
          : "ARIA organizer follow-up",
        why: selectedEvent
          ? `ARIA created this draft from an event follow-up opportunity tied to ${selectedEvent.name}. Review the audience, tone, and CTA before preparing recipients.`
          : "ARIA created this draft from an organizer follow-up opportunity. Review the audience, tone, and CTA before preparing recipients.",
        primaryStep: recipientsPrepared
          ? "Review the send readiness checklist, send a test email, then confirm the live send."
          : "Review the draft, save any edits, then prepare recipients before sending.",
      }
    : null;
  const isLocked = campaign.status !== "draft";
  const campaignHasSubject = Boolean(String(campaign.subject ?? "").trim());
  const campaignHasPreviewText = Boolean(
    String(campaign.preview_text ?? "").trim(),
  );
  const campaignHasBody = Boolean(String(campaign.body_text ?? "").trim());
  const eventAudienceReady =
    !selectedAudience.requiresEvent || Boolean(campaign.audience_event_id);
  const senderConfigured = Boolean(process.env.MARKETING_FROM_EMAIL);
  const pendingRecipientsReady = recipientTotals.pending > 0;
  const unsubscribeFooterReady = true;
  const testSentThisSession = Boolean(resolvedSearchParams.test_sent);
  const fromEmailLabel = process.env.MARKETING_FROM_EMAIL || "Not configured";
  const replyToLabel = process.env.MARKETING_REPLY_TO_EMAIL || "Sender account email";
  const liveSendConfirmationPhrase = `SEND ${recipientTotals.pending}`;
  const testEmailStatus = testSentThisSession
    ? "Test email sent during this page session."
    : "No test email has been sent during this page session.";

  const readinessItems = [
    {
      label: "Audience selected",
      ready: eventAudienceReady,
      helper: eventAudienceReady
        ? selectedAudience.label
        : "Select an event for this event-based audience, then save.",
    },
    {
      label: "Recipient list prepared",
      ready: recipientsPrepared,
      helper: recipientsPrepared
        ? `${recipientTotals.pending} pending · ${recipientTotals.unsubscribed + recipientTotals.skipped} suppressed`
        : "Prepare recipients after saving the audience.",
    },
    {
      label: "Subject line present",
      ready: campaignHasSubject,
      helper: campaignHasSubject
        ? campaign.subject
        : "Add a clear subject before sending.",
    },
    {
      label: "Preview text present",
      ready: campaignHasPreviewText,
      helper: campaignHasPreviewText
        ? campaign.preview_text ?? "Preview text saved"
        : "Add inbox preview text to reduce spam/phishing concerns.",
    },
    {
      label: "Message body present",
      ready: campaignHasBody,
      helper: campaignHasBody
        ? "Draft body is saved."
        : "Add the message body before sending.",
    },
    {
      label: "Sender configured",
      ready: senderConfigured,
      helper: senderConfigured
        ? "DanceFlow sender is configured."
        : "Marketing sender email is not configured.",
    },
    {
      label: "Unsubscribe footer included",
      ready: unsubscribeFooterReady,
      helper: "Live sends include DanceFlow footer and unsubscribe link.",
    },
    {
      label: "Test email recommended",
      ready: testSentThisSession,
      helper: testSentThisSession
        ? "A test email was sent from this page session."
        : "Send a test email before live sending when possible.",
      optional: true,
    },
  ];

  const blockingReadinessIssues = readinessItems.filter(
    (item) => !item.optional && !item.ready,
  );
  const campaignReadyToSend =
    !isLocked &&
    pendingRecipientsReady &&
    blockingReadinessIssues.length === 0 &&
    campaign.status !== "sent" &&
    campaign.status !== "sending";

  const allowedRecipientFilters = [
    "all",
    "pending",
    "sent",
    "failed",
    "unsubscribed",
    "skipped",
  ];
  const recipientStatusFilter = allowedRecipientFilters.includes(
    resolvedSearchParams.recipient_status ?? "",
  )
    ? (resolvedSearchParams.recipient_status as string)
    : "all";
  const filteredRecipients =
    recipientStatusFilter === "all"
      ? recipients
      : recipients.filter(
          (recipient) =>
            String(recipient.status ?? "pending").toLowerCase() ===
            recipientStatusFilter,
        );
  const failedRecipients = recipients.filter(
    (recipient) => String(recipient.status ?? "").toLowerCase() === "failed",
  );
  const suppressedRecipients = recipients.filter((recipient) =>
    ["unsubscribed", "skipped"].includes(
      String(recipient.status ?? "").toLowerCase(),
    ),
  );
  const completedRecipientCount =
    recipientTotals.sent +
    recipientTotals.failed +
    recipientTotals.unsubscribed +
    recipientTotals.skipped;
  const deliveryProgress = recipients.length
    ? Math.round((completedRecipientCount / recipients.length) * 100)
    : 0;
  const recipientFilterLinks = [
    { key: "all", label: "All", count: recipients.length },
    { key: "pending", label: "Pending", count: recipientTotals.pending },
    { key: "sent", label: "Sent", count: recipientTotals.sent },
    { key: "failed", label: "Failed", count: recipientTotals.failed },
    {
      key: "unsubscribed",
      label: "Suppressed",
      count: recipientTotals.unsubscribed,
    },
    { key: "skipped", label: "Skipped", count: recipientTotals.skipped },
  ];

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <Link
            href="/app/organizer-campaigns"
            className="inline-flex items-center gap-2 text-sm font-medium text-white/80 hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" /> Back to organizer campaigns
          </Link>
          <div className="mt-5 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                Organizer Campaign Detail
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                {campaign.name}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Review the saved organizer campaign, prepare recipient rows, and
                send the campaign when the audience is ready.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={`rounded-full border px-4 py-2 text-sm font-semibold ${statusBadgeClass(campaign.status)}`}
              >
                {campaign.status}
              </span>
              <Link
                href="/app/organizer-contacts"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Organizer Contacts
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

      {resolvedSearchParams.test_sent ? (
        <div className="rounded-3xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-800">
          Test email sent. No campaign recipients were contacted.
        </div>
      ) : null}

      {resolvedSearchParams.recipients_generated ? (
        <div className="rounded-3xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-800">
          Organizer campaign recipients prepared. Review the recipient counts
          before sending.
        </div>
      ) : null}

      {resolvedSearchParams.campaign_sent ? (
        <div className="rounded-3xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-800">
          Organizer campaign send started. Refresh this page to review sent,
          failed, and suppressed recipients.
        </div>
      ) : null}

      {resolvedSearchParams.campaign_error ? (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">
          Campaign action failed:{" "}
          {resolvedSearchParams.campaign_error.replaceAll("_", " ")}.
        </div>
      ) : null}

      {ariaDraftContext ? (
        <section className="rounded-[28px] border border-[#E9D5FF] bg-[#FBF7FF] p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <div className="flex items-center gap-3">
                <span className="rounded-2xl bg-white p-2 text-[#7C2D92] shadow-sm">
                  <Sparkles className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                    ARIA follow-up draft
                  </p>
                  <h2 className="mt-1 text-xl font-semibold text-slate-950">
                    Review this campaign before sending
                  </h2>
                </div>
              </div>
              <p className="mt-4 text-sm leading-6 text-slate-600">
                {ariaDraftContext.why}
              </p>
            </div>
            <div className="rounded-3xl border border-white bg-white p-4 text-sm shadow-sm lg:min-w-72">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Draft source
              </p>
              <p className="mt-1 font-semibold text-slate-950">
                {ariaDraftContext.label}
              </p>
              <p className="mt-3 text-xs leading-5 text-slate-500">
                {ariaDraftContext.primaryStep}
              </p>
            </div>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <a
              href="#campaign-draft"
              className="rounded-2xl border border-[#E9D5FF] bg-white p-3 text-sm font-semibold text-[#7C2D92] hover:bg-[#F9F1FF]"
            >
              Review Draft
            </a>
            <a
              href="#audience-targeting"
              className="rounded-2xl border border-slate-200 bg-white p-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Confirm Audience
            </a>
            <a
              href="#send-readiness"
              className="rounded-2xl border border-slate-200 bg-white p-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Check Send Readiness
            </a>
          </div>
        </section>
      ) : null}

      {shouldShowCampaignReview ? (
        <section className="rounded-[28px] border border-[#E9D5FF] bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <div className="flex items-center gap-3">
                <span className="rounded-2xl bg-[#F9F1FF] p-2 text-[#7C2D92]">
                  <Sparkles className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                    {isAriaGeneratedDraft ? "ARIA-generated campaign draft" : "Event campaign review"}
                  </p>
                  <h2 className="mt-1 text-xl font-semibold text-slate-950">
                    {selectedReviewGuidance.title}
                  </h2>
                </div>
              </div>
              <p className="mt-4 text-sm leading-6 text-slate-600">
                {selectedReviewGuidance.intent}
              </p>
              {isAriaGeneratedDraft ? (
                <p className="mt-3 rounded-2xl border border-[#E9D5FF] bg-[#FBF7FF] px-4 py-3 text-sm leading-6 text-[#5B216B]">
                  ARIA can help identify the opportunity, but the organizer should still confirm the audience, message tone, CTA, and timing before a live send.
                </p>
              ) : null}
            </div>
            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4 text-sm lg:min-w-72">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Suggested audience
              </p>
              <p className="mt-1 font-semibold text-slate-950">
                {selectedAudience.label}
              </p>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                {selectedEvent ? selectedEvent.name : "No specific event selected"}
              </p>
              <p className="mt-3 text-sm font-semibold text-[var(--brand-primary)]">
                {preview.count} deliverable · {preview.suppressed} suppressed
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="rounded-3xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-950">
                Review before sending
              </p>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
                {selectedReviewGuidance.review.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#7C2D92]" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
              <p className="font-semibold">Safety reminder</p>
              <p className="mt-2">{selectedReviewGuidance.risk}</p>
            </div>
          </div>

          <div className="mt-5 rounded-3xl border border-slate-100 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-950">
              Suggested next review steps
            </p>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {selectedReviewGuidance.nextSteps.map((step) => (
                <div
                  key={step}
                  className="rounded-2xl border border-slate-100 bg-white p-3 text-sm leading-5 text-slate-600"
                >
                  {step}
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <section className="grid gap-4 md:grid-cols-4">
        <StatCard
          label="Organizer"
          value={organizer?.name ?? "Organizer"}
          helper="Campaign owner"
          icon={Mail}
        />
        <StatCard
          label="Audience"
          value={preview.count}
          helper={`${preview.suppressed} suppressed`}
          icon={Users}
        />
        <StatCard
          label="Status"
          value={campaign.status}
          helper={isLocked ? "Locked" : "Draft editable"}
          icon={ShieldCheck}
        />
        <StatCard
          label="Recipients"
          value={recipients.length}
          helper="Prepared recipient rows"
          icon={Send}
        />
      </section>

      <section
        id="send-readiness"
        className={`rounded-[28px] border p-5 shadow-sm ${
          campaignReadyToSend
            ? "border-emerald-200 bg-emerald-50"
            : "border-amber-200 bg-amber-50"
        }`}
      >
        <div className="flex items-start gap-3">
          <div
            className={`rounded-2xl p-3 ${
              campaignReadyToSend
                ? "bg-white text-emerald-700"
                : "bg-white text-amber-700"
            }`}
          >
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h2
              className={`text-lg font-semibold ${
                campaignReadyToSend ? "text-emerald-950" : "text-amber-950"
              }`}
            >
              {campaignReadyToSend ? "Ready to send" : "Needs attention"}
            </h2>
            <p
              className={`mt-1 text-sm leading-6 ${
                campaignReadyToSend ? "text-emerald-800" : "text-amber-800"
              }`}
            >
              {campaignReadyToSend
                ? `This campaign has ${recipientTotals.pending} pending recipients and passed the required checks.`
                : blockingReadinessIssues.length > 0
                  ? `${blockingReadinessIssues.length} required item${blockingReadinessIssues.length === 1 ? "" : "s"} need attention before live send.`
                  : "Prepare pending recipients before live send."}
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {readinessItems.map((item) => (
            <div
              key={item.label}
              className="rounded-2xl border border-white/70 bg-white/75 p-3"
            >
              <div className="flex items-start gap-3">
                <span
                  className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    item.ready
                      ? "bg-emerald-100 text-emerald-700"
                      : item.optional
                        ? "bg-slate-100 text-slate-500"
                        : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {item.ready ? "✓" : item.optional ? "•" : "!"}
                </span>
                <div>
                  <p className="text-sm font-semibold text-slate-950">
                    {item.label}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    {item.helper}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div id="campaign-draft" className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="border-b border-slate-100 pb-4">
            <h2 className="text-xl font-semibold text-slate-950">
              {isAriaGeneratedDraft ? "Review ARIA draft" : "Campaign draft"}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {isAriaGeneratedDraft
                ? "ARIA prepared the starting point. Confirm the message, audience, and CTA before preparing recipients."
                : "Edit the content and audience while the campaign is still in draft status."}
            </p>
          </div>

          <form
            action={updateOrganizerCampaignDraftAction}
            className="mt-5 space-y-5"
          >
            <input type="hidden" name="campaignId" value={campaign.id} />

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm font-medium text-slate-700">
                Campaign name
                <input
                  name="name"
                  defaultValue={campaign.name}
                  disabled={isLocked}
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)] disabled:bg-slate-50 disabled:text-slate-500"
                  required
                />
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                Subject
                <input
                  name="subject"
                  defaultValue={campaign.subject}
                  disabled={isLocked}
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)] disabled:bg-slate-50 disabled:text-slate-500"
                  required
                />
              </label>
            </div>

            <label className="space-y-2 text-sm font-medium text-slate-700">
              Preview text
              <input
                name="previewText"
                defaultValue={campaign.preview_text ?? ""}
                disabled={isLocked}
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)] disabled:bg-slate-50 disabled:text-slate-500"
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm font-medium text-slate-700">
                Audience
                <select
                  name="audienceType"
                  defaultValue={campaign.audience_type}
                  disabled={isLocked}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)] disabled:bg-slate-50 disabled:text-slate-500"
                >
                  {audienceOptions.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                Event for event-based audiences
                <select
                  name="audienceEventId"
                  defaultValue={campaign.audience_event_id ?? ""}
                  disabled={isLocked}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)] disabled:bg-slate-50 disabled:text-slate-500"
                >
                  <option value="">No event selected</option>
                  {events.map((event) => (
                    <option key={event.id} value={event.id}>
                      {event.name}
                      {event.start_date
                        ? ` · ${formatDate(event.start_date)}`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div id="audience-targeting" className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-950">
                    Audience targeting summary
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {selectedAudience.description}
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                  {selectedAudience.requiresEvent ? "Event-specific" : "Organizer-wide"}
                </span>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl bg-white p-3">
                  <p className="text-xs text-slate-500">Selected source</p>
                  <p className="mt-1 text-sm font-semibold text-slate-950">
                    {selectedAudience.label}
                  </p>
                </div>
                <div className="rounded-2xl bg-white p-3">
                  <p className="text-xs text-slate-500">Audience count</p>
                  <p className="mt-1 text-sm font-semibold text-slate-950">
                    {preview.count} deliverable of {preview.total} total
                  </p>
                </div>
                <div className="rounded-2xl bg-white p-3">
                  <p className="text-xs text-slate-500">Suppression</p>
                  <p className="mt-1 text-sm font-semibold text-slate-950">
                    {preview.suppressed} unsubscribed / suppressed
                  </p>
                </div>
              </div>
              {selectedAudience.requiresEvent ? (
                <p className="mt-3 text-xs leading-5 text-slate-500">
                  Event-specific audiences use the selected event registration, payment, refund, and check-in records. If you change the audience or event, save the draft and prepare recipients again.
                </p>
              ) : (
                <p className="mt-3 text-xs leading-5 text-slate-500">
                  Organizer-wide audiences use active organizer contacts and automatically suppress unsubscribed contacts.
                </p>
              )}
              {isAriaGeneratedDraft ? (
                <p className="mt-3 rounded-2xl border border-[#E9D5FF] bg-white px-3 py-2 text-xs leading-5 text-[#5B216B]">
                  ARIA drafts should use the narrowest audience that matches the follow-up. Change the audience here, save the draft, and regenerate recipients if the suggested audience is too broad.
                </p>
              ) : null}
            </div>

            <div className="rounded-3xl border border-[#E9D5FF] bg-[#FBF7FF] p-4">
              <p className="text-sm font-semibold text-slate-950">
                Audience options available
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl bg-white p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#7C2D92]">
                    Event-specific
                  </p>
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-600">
                    {eventBasedAudienceOptions.map((option) => (
                      <li key={option.key}>• {option.label}</li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-2xl bg-white p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#7C2D92]">
                    Organizer-wide
                  </p>
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-600">
                    {broadAudienceOptions.map((option) => (
                      <li key={option.key}>• {option.label}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            <label className="space-y-2 text-sm font-medium text-slate-700">
              Message body
              <textarea
                name="bodyText"
                rows={10}
                defaultValue={campaign.body_text ?? ""}
                disabled={isLocked}
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm leading-6 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)] disabled:bg-slate-50 disabled:text-slate-500"
                required
              />
            </label>

            {!isLocked ? (
              <CampaignAIAssistant
                campaignContext="organizer"
                audienceLabel={selectedAudience.label}
                eventName={selectedEvent?.name ?? null}
                currentSubject={campaign.subject}
                currentPreviewText={campaign.preview_text}
                currentBodyText={campaign.body_text}
                ctaLabel={campaign.cta_label}
                ctaUrl={campaign.cta_url}
                compact
              />
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm font-medium text-slate-700">
                CTA label
                <input
                  name="ctaLabel"
                  defaultValue={campaign.cta_label ?? ""}
                  disabled={isLocked}
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)] disabled:bg-slate-50 disabled:text-slate-500"
                />
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                CTA URL
                <input
                  name="ctaUrl"
                  defaultValue={campaign.cta_url ?? ""}
                  disabled={isLocked}
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)] disabled:bg-slate-50 disabled:text-slate-500"
                />
              </label>
            </div>

            <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
              Save draft changes before preparing recipients. Once the campaign
              is sent, the campaign locks and future edits are disabled.
            </div>

            <button
              type="submit"
              disabled={isLocked}
              className="rounded-2xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[var(--brand-primary-dark)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save draft changes
            </button>
          </form>
        </div>

        <aside className="space-y-6">
          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <Eye className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-950">
                  Audience preview
                </h2>
                <p className="text-sm text-slate-500">
                  Current saved audience.
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-3xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-950">
                {preview.label}
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                {preview.description}
              </p>
              <div className="mt-4 grid grid-cols-3 gap-3">
                <div className="rounded-2xl bg-white p-3">
                  <p className="text-xs text-slate-500">Total</p>
                  <p className="text-2xl font-semibold text-slate-950">
                    {preview.total}
                  </p>
                </div>
                <div className="rounded-2xl bg-white p-3">
                  <p className="text-xs text-slate-500">Deliverable</p>
                  <p className="text-2xl font-semibold text-slate-950">
                    {preview.count}
                  </p>
                </div>
                <div className="rounded-2xl bg-white p-3">
                  <p className="text-xs text-slate-500">Suppressed</p>
                  <p className="text-2xl font-semibold text-slate-950">
                    {preview.suppressed}
                  </p>
                </div>
              </div>
              {selectedAudience.requiresEvent && !campaign.audience_event_id ? (
                <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  Select an event and save to preview this audience.
                </p>
              ) : preview.sample.length > 0 ? (
                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Sample contacts
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-slate-700">
                    {preview.sample.map((sample) => (
                      <li key={sample}>• {sample}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="mt-4 text-sm text-slate-500">
                  No matching contacts yet.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-emerald-50 p-3 text-emerald-700">
                <Send className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-950">
                  Send test email
                </h2>
                <p className="text-sm text-slate-500">
                  Send only to yourself or a test address.
                </p>
              </div>
            </div>
            <div
              className={`mt-5 rounded-3xl border p-4 text-sm leading-6 ${
                testSentThisSession
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-amber-200 bg-amber-50 text-amber-900"
              }`}
            >
              <p className="font-semibold">
                {testSentThisSession ? "Test sent" : "Recommended before live send"}
              </p>
              <p className="mt-1">{testEmailStatus}</p>
              <p className="mt-2 text-xs leading-5 opacity-80">
                Test emails go only to the address below and do not contact campaign recipients.
              </p>
            </div>
            <form
              action={sendOrganizerCampaignTestEmailAction}
              className="mt-5 space-y-4"
            >
              <input type="hidden" name="campaignId" value={campaign.id} />
              <label className="space-y-2 text-sm font-medium text-slate-700">
                Test email address
                <input
                  name="testEmail"
                  type="email"
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                  placeholder="you@example.com"
                />
              </label>
              <button className="w-full rounded-2xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[var(--brand-primary-dark)]">
                Send test email
              </button>
            </form>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-950">
                  Prepare recipients
                </h2>
                <p className="text-sm text-slate-500">
                  Create recipient rows from the saved audience.
                </p>
              </div>
            </div>
            <form
              action={generateOrganizerCampaignRecipientsAction}
              className="mt-5 space-y-4"
            >
              <input type="hidden" name="campaignId" value={campaign.id} />
              <div className="rounded-3xl border border-slate-100 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                This replaces any existing unsent recipient list with the
                current saved audience and suppresses organizer unsubscribes.
              </div>
              <button
                disabled={isLocked}
                className="w-full rounded-2xl border border-[var(--brand-primary)] bg-white px-5 py-3 text-sm font-semibold text-[var(--brand-primary)] shadow-sm hover:bg-[var(--brand-primary-soft)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Prepare recipient list
              </button>
            </form>
          </div>

          <div className="rounded-[28px] border border-rose-200 bg-rose-50 p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-white p-3 text-rose-700">
                <Send className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-rose-950">
                  Live send
                </h2>
                <p className="text-sm text-rose-700">
                  Sends to prepared pending recipients.
                </p>
              </div>
            </div>
            <form
              action={sendOrganizerCampaignAction}
              className="mt-5 space-y-4"
            >
              <input type="hidden" name="campaignId" value={campaign.id} />
              <input
                type="hidden"
                name="expectedPendingCount"
                value={recipientTotals.pending}
              />
              <div className="rounded-3xl border border-rose-200 bg-white p-4 text-sm leading-6 text-rose-900">
                <p className="font-semibold">Final live-send review</p>
                <div className="mt-3 grid gap-3 text-sm">
                  <div className="rounded-2xl bg-rose-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">Recipients</p>
                    <p className="mt-1 font-semibold text-rose-950">
                      {recipientTotals.pending} pending recipient{recipientTotals.pending === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-rose-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">Audience</p>
                    <p className="mt-1 font-semibold text-rose-950">{selectedAudience.label}</p>
                    <p className="mt-1 text-xs text-rose-800">
                      {selectedEvent ? selectedEvent.name : "Organizer-wide audience"}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-rose-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">Subject</p>
                    <p className="mt-1 font-semibold text-rose-950">
                      {campaign.subject || "No subject saved"}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-rose-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">Sender</p>
                    <p className="mt-1 font-semibold text-rose-950">{fromEmailLabel}</p>
                    <p className="mt-1 text-xs text-rose-800">Reply-to: {replyToLabel}</p>
                  </div>
                </div>
                <p className="mt-3 text-xs leading-5 text-rose-700">
                  Save draft changes and prepare recipients again if you changed the audience or content.
                </p>
              </div>
              {!testSentThisSession ? (
                <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                  <p className="font-semibold">Test email not confirmed</p>
                  <p className="mt-1">
                    A test email is strongly recommended before live send. You can still send after completing the required confirmation below.
                  </p>
                </div>
              ) : null}
              <label className="flex items-start gap-3 rounded-3xl border border-rose-200 bg-white p-4 text-sm leading-6 text-rose-900">
                <input
                  name="confirmSend"
                  value="yes"
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-rose-300 text-rose-700"
                />
                <span>
                  I confirm this organizer is allowed to email this audience and
                  I am ready to send this campaign live.
                </span>
              </label>
              <label className="block rounded-3xl border border-rose-200 bg-white p-4 text-sm leading-6 text-rose-900">
                <span className="font-semibold">Type {liveSendConfirmationPhrase} to confirm</span>
                <input
                  name="confirmSendPhrase"
                  className="mt-3 w-full rounded-2xl border border-rose-200 px-4 py-3 text-sm font-semibold uppercase outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-100"
                  placeholder={liveSendConfirmationPhrase}
                  autoComplete="off"
                />
              </label>
              <button
                disabled={!campaignReadyToSend}
                className="w-full rounded-2xl bg-rose-700 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Send live campaign
              </button>
              <p className="text-xs leading-5 text-rose-700">
                Pending recipients: {recipientTotals.pending}. Unsubscribed
                contacts stay suppressed and are not sent. Required checks must
                be complete before this button is enabled.
              </p>
            </form>
          </div>
        </aside>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <CheckCircle2 className="h-5 w-5 text-[var(--brand-primary)]" />
          <h3 className="mt-3 font-semibold text-slate-950">
            Controlled live send
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Prepare recipients first, confirm the send, then DanceFlow sends to
            pending recipients and locks the campaign when complete.
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <Users className="h-5 w-5 text-[var(--brand-primary)]" />
          <h3 className="mt-3 font-semibold text-slate-950">
            Audience guardrails
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Organizer audiences stay separate from studio CRM audiences and
            suppress organizer unsubscribes.
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <Mail className="h-5 w-5 text-[var(--brand-primary)]" />
          <h3 className="mt-3 font-semibold text-slate-950">
            Recipient tracking
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            This page now records pending, sent, failed, and suppressed
            recipient statuses for each organizer campaign.
          </p>
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 border-b border-slate-100 pb-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-primary)]">
              Campaign Results
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Recipient delivery dashboard
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
              Review prepared recipients, delivery results, failures, and
              unsubscribe suppression for this organizer campaign.
            </p>
          </div>
          <div className="rounded-3xl border border-slate-100 bg-slate-50 p-4 text-sm text-slate-600 lg:min-w-64">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-slate-900">Delivery progress</span>
              <span className="font-semibold text-[var(--brand-primary)]">
                {deliveryProgress}%
              </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
              <div
                className="h-full rounded-full bg-[var(--brand-primary)]"
                style={{ width: `${deliveryProgress}%` }}
              />
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-500">
              {completedRecipientCount} of {recipients.length} recipient rows
              have a final status.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-3xl border border-slate-100 bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Prepared
            </p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">
              {recipients.length}
            </p>
            <p className="mt-1 text-xs text-slate-500">Total recipient rows</p>
          </div>
          <div className="rounded-3xl border border-emerald-100 bg-emerald-50 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">
              Sent
            </p>
            <p className="mt-2 text-3xl font-semibold text-emerald-900">
              {recipientTotals.sent}
            </p>
            <p className="mt-1 text-xs text-emerald-700">Delivered to Resend</p>
          </div>
          <div className="rounded-3xl border border-amber-100 bg-amber-50 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-amber-700">
              Pending
            </p>
            <p className="mt-2 text-3xl font-semibold text-amber-900">
              {recipientTotals.pending}
            </p>
            <p className="mt-1 text-xs text-amber-700">Not sent yet</p>
          </div>
          <div className="rounded-3xl border border-rose-100 bg-rose-50 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-rose-700">
              Failed
            </p>
            <p className="mt-2 text-3xl font-semibold text-rose-900">
              {recipientTotals.failed}
            </p>
            <p className="mt-1 text-xs text-rose-700">Needs review</p>
          </div>
          <div className="rounded-3xl border border-slate-100 bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Suppressed
            </p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">
              {recipientTotals.unsubscribed + recipientTotals.skipped}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Unsubscribed or skipped
            </p>
          </div>
        </div>

        {campaign.status === "sent" ? (
          <div className="mt-5 rounded-3xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">
            <p className="font-semibold">Campaign sent</p>
            <p className="mt-1">
              This campaign was sent {formatDateTime(campaign.sent_at)}. The
              draft is locked, and future sends should be created as a new
              organizer campaign.
            </p>
          </div>
        ) : failedRecipients.length > 0 ? (
          <div className="mt-5 rounded-3xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-900">
            <p className="font-semibold">Failures need review</p>
            <p className="mt-1">
              {failedRecipients.length} recipient
              {failedRecipients.length === 1 ? "" : "s"} failed. Review the
              issue column below before deciding whether to follow up manually.
            </p>
          </div>
        ) : recipients.length > 0 ? (
          <div className="mt-5 rounded-3xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
            <p className="font-semibold text-slate-900">Recipient list ready</p>
            <p className="mt-1">
              Use the status filters below to review the prepared list and send
              results.
            </p>
          </div>
        ) : null}

        {suppressedRecipients.length > 0 ? (
          <div className="mt-5 rounded-3xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
            <p className="font-semibold text-slate-900">
              Suppressed recipients
            </p>
            <p className="mt-1">
              {suppressedRecipients.length} recipient
              {suppressedRecipients.length === 1 ? " was" : "s were"}
              suppressed because of unsubscribe or skip rules. They were not
              sent marketing email.
            </p>
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          {recipientFilterLinks.map((filter) => (
            <Link
              key={filter.key}
              href={`/app/organizer-campaigns/${campaign.id}?recipient_status=${filter.key}`}
              className={`rounded-full border px-3 py-2 text-xs font-semibold transition ${
                recipientStatusFilter === filter.key
                  ? "border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {filter.label} · {filter.count}
            </Link>
          ))}
        </div>

        {recipients.length === 0 ? (
          <div className="mt-5 rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
            <Mail className="mx-auto h-8 w-8 text-slate-400" />
            <p className="mt-3 font-medium text-slate-900">
              No recipient rows yet
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Prepare recipients from the saved audience before sending this
              campaign live.
            </p>
          </div>
        ) : filteredRecipients.length === 0 ? (
          <div className="mt-5 rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
            <p className="font-medium text-slate-900">
              No recipients match this filter
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Choose another status filter to review the rest of the campaign
              recipients.
            </p>
          </div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-3xl border border-slate-100">
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Recipient</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Sent</th>
                  <th className="px-4 py-3">Issue / Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {filteredRecipients.map((recipient) => (
                  <tr key={recipient.id}>
                    <td className="px-4 py-4">
                      <p className="font-medium text-slate-950">
                        {recipient.name || recipient.email}
                      </p>
                      <p className="mt-1 text-slate-500">{recipient.email}</p>
                    </td>
                    <td className="px-4 py-4">
                      <span
                        className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusBadgeClass(
                          recipient.status,
                        )}`}
                      >
                        {recipient.status}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-slate-500">
                      {formatDateTime(recipient.sent_at)}
                    </td>
                    <td className="px-4 py-4 text-slate-500">
                      {recipient.error_message ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}




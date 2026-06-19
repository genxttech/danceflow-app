import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { canCreateAppointments, canEditClients } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  archiveLeadAction,
  convertLeadToActiveAction,
} from "@/app/app/leads/actions";
import { completeLeadFollowUpAction } from "@/app/app/leads/activity-actions";
import QuickActionPanel from "@/components/ui/QuickActionPanel";
import LeadActivityForm from "@/app/app/leads/LeadActivityForm";
import QuickPaymentPanel from "./QuickPaymentPanel";
import { ClientSmsConsentCard } from "./ClientSmsConsentCard";
import { ClientSendSmsCard } from "./ClientSendSmsCard";
import { ClientSmsMessageHistoryCard } from "./ClientSmsMessageHistoryCard";
import ClientSyllabusTab from "./ClientSyllabusTab";
import type { SmsMessageLogRow, SmsPermissionRow } from "@/lib/sms/compliance";
import {
  linkPartnerAction,
  linkPortalAccessAction,
  sendPortalInviteAction,
  unlinkPartnerAction,
  unlinkPortalAccessAction,
  updateIndependentInstructorSettingsAction,
  adjustLessonCountCorrectionAction,
  addClientAccountLedgerEntryAction,
} from "./actions";
import {
  cancelMembershipAtPeriodEndAction,
  reactivateMembershipAutoRenewAction,
  collectReplacementPaymentMethodAction,
  retryDelinquentMembershipBillingAction,
} from "@/app/app/memberships/actions";
import { recordPayAsYouGoLessonPaymentAction } from "@/app/app/schedule/actions";

type ClientRecord = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  birthday: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  status: string;
  skill_level: string | null;
  dance_interests: string | null;
  referral_source: string | null;
  notes: string | null;
  is_independent_instructor: boolean | null;
  linked_instructor_id: string | null;
  portal_user_id: string | null;
};

type ClientPortalInviteDeliveryRow = {
  id: string;
  template_key: string | null;
  recipient_email: string | null;
  subject: string | null;
  status: string | null;
  provider_message_id: string | null;
  error_message: string | null;
  sent_at: string | null;
  created_at: string | null;
};

type ClientPortalAdminStatus = {
  lookupError: string | null;
  linkedProfile: {
    id: string;
    email: string | null;
    full_name: string | null;
    created_at: string | null;
    updated_at: string | null;
  } | null;
  matchingProfile: {
    id: string;
    email: string | null;
    full_name: string | null;
    created_at: string | null;
    updated_at: string | null;
  } | null;
  matchingAuthUser: {
    id: string;
    email: string | null;
    email_confirmed_at: string | null;
    last_sign_in_at: string | null;
    created_at: string | null;
  } | null;
  linkedAuthUser: {
    id: string;
    email: string | null;
    email_confirmed_at: string | null;
    last_sign_in_at: string | null;
    created_at: string | null;
  } | null;
  inviteDeliveries: ClientPortalInviteDeliveryRow[];
};

type StudioRecord = {
  id: string;
  name: string;
  slug: string;
};

type InstructorOption = {
  id: string;
  first_name: string;
  last_name: string;
  active: boolean;
};

type LinkedRelationshipRow = {
  client_id: string;
  related_client_id: string;
  relationship_type: string;
};

type LinkedPartnerRecord = {
  id: string;
  first_name: string;
  last_name: string;
  status: string;
};

type ClientPackageItemRow = {
  id: string;
  usage_type: string;
  quantity_total: number | null;
  quantity_used: number;
  quantity_remaining: number | null;
  is_unlimited: boolean;
};

type ClientPackageRow = {
  id: string;
  name_snapshot: string;
  expiration_date: string | null;
  active: boolean;
  client_package_items: ClientPackageItemRow[];
};

type AppointmentRow = {
  id: string;
  title: string | null;
  appointment_type: string;
  status: string;
  starts_at: string;
  ends_at: string;
  billing_type: string | null;
  payment_status: string | null;
  price_amount: number | null;
  instructors:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  rooms: { name: string } | { name: string }[] | null;
};

type PaymentRow = {
  id: string;
  amount: number;
  payment_method: string;
  status: string;
  created_at: string;
  notes: string | null;
  source: string | null;
  payment_type: string | null;
  currency: string | null;
  stripe_invoice_id: string | null;
  stripe_payment_intent_id: string | null;
};

type LedgerRow = {
  id: string;
  transaction_type: string;
  lessons_delta: number | null;
  balance_after: number | null;
  notes: string | null;
  created_at: string;
  appointment_id: string | null;
};

type ClientAccountLedgerRow = {
  id: string;
  entry_date: string;
  entry_type: string;
  direction: "credit" | "debit";
  amount: number;
  description: string | null;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
};

type LeadActivityRow = {
  id: string;
  activity_type: string;
  note: string;
  created_at: string;
  follow_up_due_at: string | null;
  completed_at: string | null;
  profiles:
    | { full_name: string | null; email: string | null }
    | { full_name: string | null; email: string | null }[]
    | null;
};

type ClientAutomationActionRow = {
  id: string;
  rule_key: string;
  title: string;
  body: string | null;
  status: string;
  priority: string | null;
  related_table: string | null;
  related_id: string | null;
  due_at: string | null;
  completed_at: string | null;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string | null;
};

type ClientAutomationDeliveryRow = {
  id: string;
  template_key: string | null;
  recipient_email: string | null;
  subject: string | null;
  status: string;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
  related_id: string | null;
};

type PackageTemplateRow = {
  id: string;
  name: string;
  price: number | null;
};

type MembershipPlanOption = {
  id: string;
  name: string;
  billing_interval: string;
  price: number;
  active: boolean;
};

type MembershipBenefit = {
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string;
  applies_to: string | null;
};

type ActiveMembership = {
  id: string;
  membership_plan_id: string | null;
  status: string;
  starts_on: string;
  ends_on: string | null;
  current_period_start: string;
  current_period_end: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
  name_snapshot: string;
  price_snapshot: number;
  billing_interval_snapshot: string;
  benefits: MembershipBenefit[];
};


type SyllabusTemplateItemRow = {
  id: string;
  title: string;
  category: string | null;
  description: string | null;
  sort_order: number | null;
  active: boolean | null;
};

type SyllabusTemplateRow = {
  id: string;
  name: string;
  dance_style: string | null;
  level: string | null;
  description: string | null;
  active: boolean | null;
  syllabus_template_items: SyllabusTemplateItemRow[] | null;
};

type ClientSyllabusProgressRow = {
  id: string;
  template_item_id: string;
  status: string;
  notes: string | null;
  show_notes_in_portal: boolean | null;
  updated_at: string | null;
};

type ClientSyllabusAssignmentRow = {
  id: string;
  syllabus_template_id: string;
  assigned_at: string | null;
  visible_in_portal: boolean | null;
  archived_at: string | null;
  syllabus_templates: SyllabusTemplateRow | SyllabusTemplateRow[] | null;
  client_syllabus_progress: ClientSyllabusProgressRow[] | null;
};

type EventRegistrationRow = {
  id: string;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  status: string;
  payment_status: string | null;
  quantity: number;
  unit_price: number | null;
  total_price: number | null;
  total_amount: number | null;
  currency: string | null;
  registration_source: string | null;
  source: string | null;
  notes: string | null;
  created_at: string;
  checked_in_at: string | null;
  promoted_from_waitlist_at: string | null;
  event_ticket_types:
    | { name: string | null }
    | { name: string | null }[]
    | null;
  events:
    | {
        id: string;
        name: string;
        slug: string;
        start_date: string | null;
        end_date: string | null;
      }
    | {
        id: string;
        name: string;
        slug: string;
        start_date: string | null;
        end_date: string | null;
      }[]
    | null;
};

type ClientDocumentAssignmentRow = {
  id: string;
  template_id: string;
  status: string;
  assigned_at: string | null;
  due_at: string | null;
  signed_at: string | null;
  document_templates:
    | {
        title: string | null;
        document_type: string | null;
        requires_signature: boolean | null;
        is_required: boolean | null;
      }
    | {
        title: string | null;
        document_type: string | null;
        requires_signature: boolean | null;
        is_required: boolean | null;
      }[]
    | null;
};

type AllClientDocumentTemplateRow = {
  id: string;
  title: string;
  document_type: string | null;
  requires_signature: boolean | null;
  is_required: boolean | null;
};

type ClientDocumentSignatureRow = {
  template_id: string;
  signed_at: string | null;
};


type AttendanceRecordRow = {
  id: string;
  event_registration_id: string;
  status: string;
  checked_in_at: string | null;
  marked_attended_at: string | null;
};

type SearchParams = Promise<{
  notificationId?: string;
  success?: string;
  error?: string;
  tab?: string;
  sms_consent?: string;
  sms_error?: string;
}>;

type ClientDetailTab =
  | "overview"
  | "schedule"
  | "billing"
  | "marketing"
  | "documents"
  | "syllabus"
  | "notes"
  | "portal";

const clientDetailTabs: { id: ClientDetailTab; label: string; description: string }[] = [
  { id: "overview", label: "Overview", description: "Snapshot, lead status, event history, and next best actions" },
  { id: "schedule", label: "Schedule", description: "Upcoming and recent lessons, classes, and rentals" },
  { id: "billing", label: "Packages & Billing", description: "Packages, payments, memberships, credits, and ledger activity" },
  { id: "marketing", label: "Marketing", description: "Follow-up, SMS consent, one-to-one texting, and message history" },
  { id: "documents", label: "Documents", description: "Waivers, policies, agreements, and signature status" },
  { id: "syllabus", label: "Syllabus", description: "Dance figure progress, instructor notes, and student focus areas" },
  { id: "notes", label: "Notes / Activity", description: "Internal notes, lead activity, and completed follow-ups" },
  { id: "portal", label: "Portal / Account", description: "Client portal access, linked account tools, and profile visibility" },
];

function getClientDetailTab(value: string | undefined): ClientDetailTab {
  return clientDetailTabs.some((tab) => tab.id === value)
    ? (value as ClientDetailTab)
    : "overview";
}

type PackageHealth =
  | "healthy"
  | "low_balance"
  | "depleted"
  | "inactive"
  | "expired"
  | "unknown";

type HostStudioPortalLink = {
  client_id: string;
  studio_id: string;
  studio_name: string;
  studio_slug: string;
};

function usageLabel(value: string) {
  if (value === "private_lesson") return "Private Lessons";
  if (value === "group_class") return "Group Classes";
  if (value === "practice_party") return "Practice Parties";
  return value;
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice Party";
  if (value === "floor_space_rental") return "Floor Space Rental";
  if (value === "event") return "Event";
  return value.replaceAll("_", " ");
}

function appointmentTypeBadgeClass(value: string) {
  if (value === "floor_space_rental") return "bg-indigo-50 text-indigo-700";
  if (value === "intro_lesson") return "bg-cyan-50 text-cyan-700";
  if (value === "group_class") return "bg-green-50 text-green-700";
  if (value === "coaching") return "bg-purple-50 text-purple-700";
  if (value === "practice_party") return "bg-amber-50 text-amber-700";
  if (value === "event") return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-700";
}

const CLIENT_DETAIL_DEFAULT_TIME_ZONE = "America/New_York";

function fmtDateTime(value: string, timeZone = CLIENT_DETAIL_DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function fmtShortDateTime(value: string, timeZone = CLIENT_DETAIL_DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function fmtShortDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtPortalDateTime(value: string | null | undefined) {
  if (!value) return "Not recorded";
  return fmtShortDateTime(value);
}

async function loadClientPortalAdminStatus(
  client: ClientRecord,
  studioId: string
): Promise<ClientPortalAdminStatus> {
  const emptyStatus: ClientPortalAdminStatus = {
    lookupError: null,
    linkedProfile: null,
    matchingProfile: null,
    matchingAuthUser: null,
    linkedAuthUser: null,
    inviteDeliveries: [],
  };

  const email = client.email?.trim().toLowerCase();

  if (!email && !client.portal_user_id) {
    return emptyStatus;
  }

  try {
    const adminSupabase = createAdminClient();

    const [linkedProfileResult, matchingProfileResult, matchingAuthResult, inviteDeliveryResult] =
      await Promise.all([
        client.portal_user_id
          ? adminSupabase
              .from("profiles")
              .select("id, email, full_name, created_at, updated_at")
              .eq("id", client.portal_user_id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        email
          ? adminSupabase
              .from("profiles")
              .select("id, email, full_name, created_at, updated_at")
              .ilike("email", email)
              .limit(1)
          : Promise.resolve({ data: null, error: null }),
        email
          ? adminSupabase
              .schema("auth")
              .from("users")
              .select("id, email, email_confirmed_at, last_sign_in_at, created_at")
              .ilike("email", email)
              .limit(1)
          : Promise.resolve({ data: null, error: null }),
        adminSupabase
          .from("outbound_deliveries")
          .select("id, template_key, recipient_email, subject, status, provider_message_id, error_message, sent_at, created_at")
          .eq("studio_id", studioId)
          .eq("related_table", "clients")
          .eq("related_id", client.id)
          .in("template_key", ["client_portal_invite", "portal_invite", "client_portal_access_invite"])
          .order("created_at", { ascending: false })
          .limit(5),
      ]);

    if (linkedProfileResult.error) throw linkedProfileResult.error;
    if (matchingProfileResult.error) throw matchingProfileResult.error;
    if (matchingAuthResult.error) throw matchingAuthResult.error;
    if (inviteDeliveryResult.error) throw inviteDeliveryResult.error;

    let linkedAuthUser = null;

    if (client.portal_user_id) {
      const { data: linkedAuthData, error: linkedAuthError } =
        await adminSupabase.auth.admin.getUserById(client.portal_user_id);

      if (!linkedAuthError) {
        const user = linkedAuthData.user;
        linkedAuthUser = user
          ? {
              id: user.id,
              email: user.email ?? null,
              email_confirmed_at: user.email_confirmed_at ?? null,
              last_sign_in_at: user.last_sign_in_at ?? null,
              created_at: user.created_at ?? null,
            }
          : null;
      }
    }

    const matchingProfiles = Array.isArray(matchingProfileResult.data)
      ? matchingProfileResult.data
      : [];
    const matchingAuthUsers = Array.isArray(matchingAuthResult.data)
      ? matchingAuthResult.data
      : [];

    return {
      lookupError: null,
      linkedProfile: linkedProfileResult.data ?? null,
      matchingProfile: matchingProfiles[0] ?? null,
      matchingAuthUser: matchingAuthUsers[0] ?? null,
      linkedAuthUser,
      inviteDeliveries: (inviteDeliveryResult.data ?? []) as ClientPortalInviteDeliveryRow[],
    };
  } catch (error) {
    return {
      ...emptyStatus,
      lookupError: error instanceof Error ? error.message : "Portal account lookup failed.",
    };
  }
}

function fmtCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(value);
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700";
  if (status === "attended") return "bg-green-50 text-green-700";
  if (status === "cancelled") return "bg-red-50 text-red-700";
  if (status === "no_show") return "bg-amber-50 text-amber-700";
  if (status === "rescheduled") return "bg-purple-50 text-purple-700";
  if (status === "active") return "bg-green-50 text-green-700";
  if (status === "lead") return "bg-blue-50 text-blue-700";
  if (status === "inactive") return "bg-slate-100 text-slate-700";
  if (status === "archived") return "bg-red-50 text-red-700";
  if (status === "paid") return "bg-green-50 text-green-700";
  if (status === "pending") return "bg-amber-50 text-amber-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  if (status === "refunded") return "bg-blue-50 text-blue-700";
  if (status === "paused") return "bg-amber-50 text-amber-700";
  if (status === "expired") return "bg-slate-100 text-slate-700";
  if (status === "past_due") return "bg-amber-50 text-amber-700";
  if (status === "unpaid") return "bg-red-50 text-red-700";
  if (status === "partial") return "bg-amber-50 text-amber-700";
  if (status === "confirmed") return "bg-green-50 text-green-700";
  if (status === "checked_in") return "bg-blue-50 text-blue-700";
  if (status === "waitlisted") return "bg-purple-50 text-purple-700";
  return "bg-slate-100 text-slate-700";
}

function activityLabel(value: string) {
  if (value === "follow_up") return "Follow Up";
  if (value === "call") return "Call";
  if (value === "text") return "Text";
  if (value === "email") return "Email";
  if (value === "consultation") return "Consultation";
  return "Note";
}

function automationRuleLabel(value: string) {
  if (value === "low_package_balance") return "Low Package Balance";
  if (value === "no_upcoming_lesson") return "No Upcoming Lesson";
  if (value === "pending_booking_request") return "Pending Booking Request";
  if (value === "unsigned_document") return "Unsigned Document";
  if (value === "first_lesson_follow_up") return "First Lesson Follow-Up";
  return value.replaceAll("_", " ");
}

function automationStatusBadgeClass(status: string) {
  if (status === "suggested") return "bg-amber-50 text-amber-700";
  if (status === "drafted") return "bg-blue-50 text-blue-700";
  if (status === "queued") return "bg-purple-50 text-purple-700";
  if (status === "completed") return "bg-green-50 text-green-700";
  if (status === "dismissed") return "bg-slate-100 text-slate-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  return "bg-slate-100 text-slate-700";
}

function deliveryStatusBadgeClass(status: string) {
  if (status === "draft") return "bg-blue-50 text-blue-700";
  if (status === "queued") return "bg-purple-50 text-purple-700";
  if (status === "sent") return "bg-green-50 text-green-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  if (status === "skipped") return "bg-slate-100 text-slate-700";
  return "bg-slate-100 text-slate-700";
}

function getInstructorName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
) {
  const instructor = Array.isArray(value) ? value[0] : value;
  return instructor
    ? `${instructor.first_name} ${instructor.last_name}`
    : "No instructor";
}

function getRoomName(value: { name: string } | { name: string }[] | null) {
  const room = Array.isArray(value) ? value[0] : value;
  return room?.name ?? "No room";
}

function getAuthorName(
  value:
    | { full_name: string | null; email: string | null }
    | { full_name: string | null; email: string | null }[]
    | null
) {
  const author = Array.isArray(value) ? value[0] : value;
  return author?.full_name || author?.email || "Unknown";
}

function getLowestRemainingValue(items: ClientPackageItemRow[]) {
  const finiteItems = items.filter(
    (item) => !item.is_unlimited && typeof item.quantity_remaining === "number"
  );

  if (finiteItems.length === 0) return null;

  return Math.min(...finiteItems.map((item) => Number(item.quantity_remaining ?? 0)));
}

function getPackageHealth(pkg: ClientPackageRow): PackageHealth {
  if (!pkg.active) return "inactive";

  if (pkg.expiration_date) {
    const expiration = new Date(pkg.expiration_date);
    const now = new Date();

    if (expiration < now) {
      return "expired";
    }
  }

  const lowestRemaining = getLowestRemainingValue(pkg.client_package_items);

  if (lowestRemaining === null) return "healthy";
  if (lowestRemaining <= 0) return "depleted";
  if (lowestRemaining === 1) return "low_balance";

  return "healthy";
}

function packageHealthLabel(health: PackageHealth) {
  if (health === "healthy") return "Active";
  if (health === "low_balance") return "Low Balance";
  if (health === "depleted") return "Depleted";
  if (health === "inactive") return "Inactive";
  if (health === "expired") return "Expired";
  return "Unknown";
}

function packageHealthClass(health: PackageHealth) {
  if (health === "healthy") return "bg-green-50 text-green-700";
  if (health === "low_balance") return "bg-amber-50 text-amber-700";
  if (health === "depleted") return "bg-red-50 text-red-700";
  if (health === "inactive" || health === "expired") {
    return "bg-slate-100 text-slate-700";
  }
  return "bg-slate-100 text-slate-700";
}

function packageWarningMessage(health: PackageHealth) {
  if (health === "inactive") return "This package is inactive.";
  if (health === "expired") return "This package is expired.";
  if (health === "depleted") return "This package has no remaining balance.";
  if (health === "low_balance") return "This package is low on remaining balance.";
  return "";
}

function getLinkedInstructorName(
  instructors: InstructorOption[],
  linkedInstructorId: string | null
) {
  if (!linkedInstructorId) return "None linked";
  const instructor = instructors.find((item) => item.id === linkedInstructorId);
  return instructor
    ? `${instructor.first_name} ${instructor.last_name}`
    : "Linked instructor not found";
}

function isFloorRental(appointmentType: string) {
  return appointmentType === "floor_space_rental";
}

function billingIntervalLabel(value: string) {
  if (value === "monthly") return "Monthly";
  if (value === "quarterly") return "Quarterly";
  if (value === "yearly") return "Yearly";
  return value;
}

function paymentSourceLabel(source: string | null) {
  if (source === "stripe") return "Stripe";
  if (source === "manual") return "Manual";
  return "Unknown";
}

function paymentSourceBadgeClass(source: string | null) {
  if (source === "stripe") return "bg-indigo-50 text-indigo-700";
  if (source === "manual") return "bg-slate-100 text-slate-700";
  return "bg-slate-100 text-slate-700";
}

function paymentTypeLabel(value: string | null) {
  if (value === "membership") return "Membership";
  if (value === "package_sale") return "Package Sale";
  if (value === "event_registration") return "Event Registration";
  if (value === "floor_rental") return "Floor Rental";
  if (value === "other") return "Other";
  return "General";
}

function paymentTypeBadgeClass(value: string | null) {
  if (value === "membership") return "bg-purple-50 text-purple-700";
  if (value === "package_sale") return "bg-cyan-50 text-cyan-700";
  if (value === "event_registration") return "bg-rose-50 text-rose-700";
  if (value === "floor_rental") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

function accountLedgerTypeLabel(value: string) {
  if (value === "credit_added") return "Credit Added";
  if (value === "credit_applied") return "Credit Applied";
  if (value === "charge_added") return "Charge Added";
  if (value === "payment_received") return "Payment Received";
  if (value === "refund_credit") return "Refund Credit";
  if (value === "manual_adjustment") return "Manual Adjustment";
  if (value === "floor_fee_credit") return "Floor Fee Credit";
  if (value === "floor_fee_charge") return "Floor Fee Charge";
  if (value === "package_purchase") return "Package Purchase";
  if (value === "lesson_charge") return "Lesson Charge";
  if (value === "reversal") return "Reversal";
  return value.replaceAll("_", " ");
}

function accountDirectionBadgeClass(direction: string) {
  if (direction === "credit") return "bg-green-50 text-green-700";
  if (direction === "debit") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-700";
}


function paymentMethodLabel(value: string) {
  if (value === "bank_transfer") return "Bank Transfer";
  return value.replaceAll("_", " ");
}

function formatClientBirthday(value: string | null) {
  if (!value) return "—";

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
  });
}

function formatMailingAddress(client: Pick<ClientRecord, "address_line1" | "address_line2" | "city" | "state" | "postal_code" | "country">) {
  const cityStateZip = [client.city, client.state, client.postal_code]
    .filter(Boolean)
    .join(", ")
    .replace(/, ([^,]*)$/, " $1");

  const lines = [client.address_line1, client.address_line2, cityStateZip, client.country].filter(Boolean);

  return lines.length ? lines : ["—"];
}

function leadSourceLabel(value: string | null) {
  if (!value) return "Direct / manual";
  if (value === "public_intro_booking") return "Public Intro";
  if (value === "event_registration") return "Event Registration";
  return value.replaceAll("_", " ");
}

function leadSourceBadgeClass(value: string | null) {
  if (value === "public_intro_booking") return "bg-blue-50 text-blue-700";
  if (value === "event_registration") return "bg-rose-50 text-rose-700";
  if (!value) return "bg-slate-100 text-slate-700";
  return "bg-slate-100 text-slate-700";
}

function leadRecommendedNextStep(params: {
  isPublicIntroLead: boolean;
  isEventRegistrationLead: boolean;
}) {
  if (params.isPublicIntroLead) {
    return "Book the intro lesson, confirm attendance, collect payment, and move them into their first package or membership.";
  }

  if (params.isEventRegistrationLead) {
    return "Follow up after the event, confirm engagement, and convert them into a first private lesson, intro, or starter package.";
  }

  return "Make first contact, log follow-up activity, and move them into their first booked and paid service.";
}

function isMembershipPayment(payment: PaymentRow) {
  return payment.payment_type === "membership";
}

function getLatestMembershipPayment(payments: PaymentRow[]) {
  return payments.length > 0 ? payments[0] : null;
}

function getDelinquencyConfig(activeMembership: ActiveMembership | null) {
  if (!activeMembership) return null;

  if (activeMembership.status === "unpaid") {
    return {
      tone: "red" as const,
      title: "Membership billing requires immediate attention",
      message:
        "This membership is marked unpaid. Confirm payment status, collect a new payment method if needed, and avoid assuming recurring billing is healthy until resolved.",
      nextStep:
        "Recommended action: review recent invoices, contact the client, and collect payment or a new card on file.",
    };
  }

  if (activeMembership.status === "past_due") {
    return {
      tone: "amber" as const,
      title: "Membership billing is past due",
      message:
        "A recent membership charge did not complete successfully. The subscription still exists, but staff should follow up before relying on it as fully healthy.",
      nextStep:
        "Recommended action: review recent payment attempts, contact the client, update the payment method if necessary, and retry billing.",
    };
  }

  return null;
}

function hasRecoveredMembershipBilling(
  activeMembership: ActiveMembership | null,
  membershipPayments: PaymentRow[]
) {
  if (!activeMembership) return false;
  if (activeMembership.status !== "active") return false;

  const hasSuccessfulMembershipPayment = membershipPayments.some(
    (payment) => payment.status === "paid"
  );

  const hasFailedMembershipPayment = membershipPayments.some(
    (payment) => payment.status === "failed"
  );

  return hasSuccessfulMembershipPayment && hasFailedMembershipPayment;
}

function getBanner(search: { success?: string; error?: string }) {
    if (search.success === "portal_invite_sent") {
    return {
      kind: "success" as const,
      message: "Portal invite sent.",
    };
  }

  if (search.error === "portal_invite_failed") {
    return {
      kind: "error" as const,
      message: "Could not send the portal invite.",
    };
  }
  
  if (search.success === "independent_instructor_updated") {
    return {
      kind: "success" as const,
      message: "Independent instructor settings updated.",
    };
  }

  if (search.success === "account_ledger_entry_saved") {
    return {
      kind: "success" as const,
      message: "Client account ledger entry saved.",
    };
  }

  if (search.success === "payment_recorded") {
    return {
      kind: "success" as const,
      message: "Lesson payment recorded and linked to the lesson.",
    };
  }

  if (search.success === "membership_assigned") {
    return {
      kind: "success" as const,
      message: "Membership assigned.",
    };
  }

  if (search.success === "membership_cancelled") {
    return {
      kind: "success" as const,
      message: "Membership cancelled.",
    };
  }

  if (search.success === "membership_subscription_created") {
    return {
      kind: "success" as const,
      message: "Membership sold successfully.",
    };
  }

  if (search.success === "membership_cancel_at_period_end") {
    return {
      kind: "success" as const,
      message: "Membership will cancel at the end of the current billing period.",
    };
  }

  if (search.success === "partner_linked") {
    return {
      kind: "success" as const,
      message: "Partner linked successfully.",
    };
  }

  if (search.success === "partner_unlinked") {
    return {
      kind: "success" as const,
      message: "Partner link removed successfully.",
    };
  }

  if (search.error === "partner_same_as_client") {
    return {
      kind: "error" as const,
      message: "A client cannot be linked as their own partner.",
    };
  }

  if (search.error === "partner_client_not_found") {
    return {
      kind: "error" as const,
      message: "The selected partner could not be found in this studio.",
    };
  }

  if (search.error === "partner_link_failed") {
    return {
      kind: "error" as const,
      message: "We could not save the partner link.",
    };
  }

  if (search.error === "partner_unlink_failed") {
    return {
      kind: "error" as const,
      message: "We could not remove the partner link.",
    };
  }

  if (search.success === "membership_auto_renew_restored") {
    return {
      kind: "success" as const,
      message: "Auto-renew has been turned back on for this membership.",
    };
  }

  if (search.success === "membership_payment_method_updated") {
    return {
      kind: "success" as const,
      message: "Payment method updated for this membership.",
    };
  }

  if (search.success === "membership_retry_submitted") {
    return {
      kind: "success" as const,
      message:
        "Membership billing retry submitted. Review payments and membership status shortly.",
    };
  }

  if (search.error === "invalid_linked_instructor") {
    return {
      kind: "error" as const,
      message: "The selected linked instructor is invalid for this studio.",
    };
  }

  if (search.error === "independent_instructor_update_failed") {
    return {
      kind: "error" as const,
      message: "Could not save independent instructor settings.",
    };
  }

  if (search.error === "client_not_found") {
    return {
      kind: "error" as const,
      message: "Client not found.",
    };
  }

  if (search.error === "missing_client") {
    return {
      kind: "error" as const,
      message: "Missing client selection.",
    };
  }

  if (search.error === "invalid_payment_amount") {
    return {
      kind: "error" as const,
      message: "Enter a payment amount, account credit amount, or both before recording the lesson payment.",
    };
  }

  if (search.error === "payment_still_short") {
    return {
      kind: "error" as const,
      message: "The payment and account credit applied do not cover the lesson price yet.",
    };
  }

  if (search.error === "credit_exceeds_available") {
    return {
      kind: "error" as const,
      message: "The account credit applied is higher than the available client credit.",
    };
  }

  if (search.error === "credit_exceeds_lesson_price") {
    return {
      kind: "error" as const,
      message: "The account credit applied cannot be more than the lesson price.",
    };
  }

  if (search.error === "lesson_already_paid") {
    return {
      kind: "error" as const,
      message: "This lesson is already marked paid. Open the lesson or payment history to review it.",
    };
  }

  if (search.error === "payment_record_failed") {
    return {
      kind: "error" as const,
      message: "Could not record the lesson payment. Please review the amount and try again.",
    };
  }

  if (search.error === "unauthorized") {
    return {
      kind: "error" as const,
      message: "You do not have permission to update this client.",
    };
  }

  if (search.error === "active_membership_exists") {
    return {
      kind: "error" as const,
      message: "Client already has an active membership.",
    };
  }

  if (search.error === "membership_plan_not_found") {
    return {
      kind: "error" as const,
      message: "Membership plan not found.",
    };
  }

  if (search.error === "missing_membership_start") {
    return {
      kind: "error" as const,
      message: "Membership start date is required.",
    };
  }

  if (search.error === "membership_lookup_failed") {
    return {
      kind: "error" as const,
      message: "Could not check the client’s current membership.",
    };
  }

  if (search.error === "membership_assign_failed") {
    return {
      kind: "error" as const,
      message: "Could not assign membership.",
    };
  }

  if (search.error === "membership_cancel_failed") {
    return {
      kind: "error" as const,
      message: "Could not cancel membership.",
    };
  }

  if (search.error === "membership_not_found") {
    return {
      kind: "error" as const,
      message: "Membership record was not found.",
    };
  }

  if (search.error === "stripe_subscription_not_found") {
    return {
      kind: "error" as const,
      message: "Linked subscription record was not found.",
    };
  }

  if (search.error === "membership_reactivate_failed") {
    return {
      kind: "error" as const,
      message: "Could not restore auto-renew for this membership.",
    };
  }

  if (search.error === "membership_payment_method_update_failed") {
    return {
      kind: "error" as const,
      message: "Could not start the payment method update flow.",
    };
  }

  if (search.error === "membership_retry_failed") {
    return {
      kind: "error" as const,
      message: "Could not retry membership billing.",
    };
  }

  if (search.error === "membership_retry_not_allowed") {
    return {
      kind: "error" as const,
      message: "This membership is not in a retryable billing state.",
    };
  }

  if (search.error === "account_ledger_missing_fields") {
    return {
      kind: "error" as const,
      message: "Amount, type, date, and notes are required for account ledger entries.",
    };
  }

  if (search.error === "account_ledger_invalid_amount") {
    return {
      kind: "error" as const,
      message: "Enter a valid account ledger amount greater than zero.",
    };
  }

  if (search.error === "account_ledger_invalid_type") {
    return {
      kind: "error" as const,
      message: "Choose a valid account ledger entry type.",
    };
  }

  if (search.error === "account_ledger_save_failed") {
    return {
      kind: "error" as const,
      message: "Could not save the client account ledger entry.",
    };
  }

  if (search.error === "missing_default_payment_method") {
    return {
      kind: "error" as const,
      message:
        "The client needs a saved default payment method before billing can be retried.",
    };
  }

    if (search.success === "portal_linked") {
    return {
      kind: "success" as const,
      message: "Portal access linked to an existing account.",
    };
  }

  if (search.success === "portal_unlinked") {
    return {
      kind: "success" as const,
      message: "Portal access unlinked.",
    };
  }

  if (search.error === "portal_email_required") {
    return {
      kind: "error" as const,
      message: "This client needs an email address before portal access can be linked.",
    };
  }

  if (search.error === "portal_account_not_found") {
    return {
      kind: "error" as const,
      message:
        "No existing account was found for this email yet. Have the user create their account first, then link portal access.",
    };
  }

  if (search.error === "portal_lookup_failed") {
    return {
      kind: "error" as const,
      message: "Could not look up an existing portal account.",
    };
  }

  if (search.error === "portal_link_failed") {
    return {
      kind: "error" as const,
      message: "Could not link portal access.",
    };
  }

  if (search.error === "portal_unlink_failed") {
    return {
      kind: "error" as const,
      message: "Could not unlink portal access.",
    };
  }

  return null;
}

function SectionCard({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[28px] border border-[var(--brand-border)] bg-white/92 p-6 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-xl font-semibold text-[var(--brand-text)]">{title}</h3>
          {subtitle ? (
            <p className="mt-1 text-sm text-slate-600">{subtitle}</p>
          ) : null}
        </div>
        {action}
      </div>

      <div className="mt-5">{children}</div>
    </div>
  );
}

function getEventValue(
  value:
    | {
        id: string;
        name: string;
        slug: string;
        start_date: string | null;
        end_date: string | null;
      }
    | {
        id: string;
        name: string;
        slug: string;
        start_date: string | null;
        end_date: string | null;
      }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function getTicketValue(
  value: { name: string | null } | { name: string | null }[] | null
) {
  return Array.isArray(value) ? value[0] : value;
}


function getDocumentTemplateValue(
  value:
    | {
        title: string | null;
        document_type: string | null;
        requires_signature: boolean | null;
        is_required: boolean | null;
      }
    | {
        title: string | null;
        document_type: string | null;
        requires_signature: boolean | null;
        is_required: boolean | null;
      }[]
    | null,
) {
  return Array.isArray(value) ? value[0] : value;
}

function documentStatusClass(status: string) {
  if (status === "signed" || status === "completed") return "bg-green-50 text-green-700";
  if (status === "declined") return "bg-red-50 text-red-700";
  if (status === "expired") return "bg-slate-100 text-slate-600";
  return "bg-amber-50 text-amber-700";
}

function documentStatusLabel(status: string) {
  if (status === "signed") return "Signed";
  if (status === "completed") return "Completed";
  if (status === "declined") return "Declined";
  if (status === "expired") return "Expired";
  return "Pending";
}

function eventRegistrationStatusLabel(status: string) {
  if (status === "confirmed") return "Confirmed";
  if (status === "pending") return "Pending";
  if (status === "waitlisted") return "Waitlisted";
  if (status === "checked_in") return "Checked In";
  if (status === "attended") return "Attended";
  if (status === "cancelled") return "Cancelled";
  if (status === "refunded") return "Refunded";
  return status.replaceAll("_", " ");
}

export default async function ClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const query = await searchParams;
  const notificationId = query.notificationId ?? "";
  const banner = getBanner(query);
  const activeTab = getClientDetailTab(query.tab);
  const activeTabInfo = clientDetailTabs.find((tab) => tab.id === activeTab) ?? clientDetailTabs[0];

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  
  const studioId = context.studioId;
  const role = context.studioRole ?? "";
  const nowIso = new Date().toISOString();
  const returnTo = `/app/clients/${id}`;

  

  if (notificationId) {
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", notificationId)
      .eq("studio_id", studioId)
      .is("read_at", null);
  }

  const [
    { data: studio, error: studioError },
    { data: client, error: clientError },
    { data: instructors, error: instructorsError },
    { data: packages, error: packagesError },
    { data: upcomingAppointments, error: upcomingError },
    { data: recentAppointments, error: recentError },
    { data: payments, error: paymentsError },
    { data: ledger, error: ledgerError },
    { data: accountLedger, error: accountLedgerError },
    { data: leadActivities, error: leadActivitiesError },
    { data: packageTemplates, error: packageTemplatesError },
    { data: membershipPlans, error: membershipPlansError },
    { data: activeMembership, error: activeMembershipError },
    { data: eventRegistrations, error: eventRegistrationsError },
    { data: documentAssignments, error: documentAssignmentsError },
    { data: allClientDocumentTemplates, error: allClientDocumentTemplatesError },
    { data: documentSignatures, error: documentSignaturesError },
    { data: smsPermission, error: smsPermissionError },
    { data: smsMessages, error: smsMessagesError },
    { data: syllabusTemplates, error: syllabusTemplatesError },
    { data: syllabusAssignments, error: syllabusAssignmentsError },
  ] = await Promise.all([
    supabase.from("studios").select("id, name, slug, timezone").eq("id", studioId).single(),

    supabase
      .from("clients")
      .select(`
        id,
        first_name,
        last_name,
        email,
        phone,
        birthday,
        address_line1,
        address_line2,
        city,
        state,
        postal_code,
        country,
        status,
        skill_level,
        dance_interests,
        referral_source,
        notes,
        is_independent_instructor,
        linked_instructor_id,
        portal_user_id
      `)
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),

    supabase
      .from("instructors")
      .select("id, first_name, last_name, active")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("first_name", { ascending: true }),

    supabase
      .from("client_packages")
      .select(`
        id,
        name_snapshot,
        expiration_date,
        active,
        client_package_items (
          id,
          usage_type,
          quantity_total,
          quantity_used,
          quantity_remaining,
          is_unlimited
        )
      `)
      .eq("studio_id", studioId)
      .eq("client_id", id)
      .order("purchase_date", { ascending: false }),

    supabase
      .from("appointments")
      .select(`
        id,
        title,
        appointment_type,
        status,
        starts_at,
        ends_at,
        billing_type,
        payment_status,
        price_amount,
        instructors ( first_name, last_name ),
        rooms ( name )
      `)
      .eq("studio_id", studioId)
      .eq("client_id", id)
      .gte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(12),

    supabase
      .from("appointments")
      .select(`
        id,
        title,
        appointment_type,
        status,
        starts_at,
        ends_at,
        billing_type,
        payment_status,
        price_amount,
        instructors ( first_name, last_name ),
        rooms ( name )
      `)
      .eq("studio_id", studioId)
      .eq("client_id", id)
      .lt("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(12),

    supabase
      .from("payments")
      .select(`
        id,
        amount,
        payment_method,
        status,
        created_at,
        notes,
        source,
        payment_type,
        currency,
        stripe_invoice_id,
        stripe_payment_intent_id
      `)
      .eq("studio_id", studioId)
      .eq("client_id", id)
      .order("created_at", { ascending: false })
      .limit(20),

    supabase
      .from("lesson_transactions")
      .select(
        "id, transaction_type, lessons_delta, balance_after, notes, created_at, appointment_id"
      )
      .eq("studio_id", studioId)
      .eq("client_id", id)
      .order("created_at", { ascending: false })
      .limit(30),

    supabase
      .from("client_account_ledger")
      .select(
        "id, entry_date, entry_type, direction, amount, description, reference_type, reference_id, created_at"
      )
      .eq("studio_id", studioId)
      .eq("client_id", id)
      .order("entry_date", { ascending: false })
      .order("created_at", { ascending: false }),

    supabase
      .from("lead_activities")
      .select(`
        id,
        activity_type,
        note,
        created_at,
        follow_up_due_at,
        completed_at,
        profiles:created_by (
          full_name,
          email
        )
      `)
      .eq("studio_id", studioId)
      .eq("client_id", id)
      .order("created_at", { ascending: false }),

    supabase
      .from("package_templates")
      .select(`
        id,
        name,
        price
      `)
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("name", { ascending: true }),

    supabase
      .from("membership_plans")
      .select("id, name, billing_interval, price, active")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),

    supabase
      .from("client_memberships")
      .select(`
        id,
        membership_plan_id,
        status,
        starts_on,
        ends_on,
        current_period_start,
        current_period_end,
        auto_renew,
        cancel_at_period_end,
        name_snapshot,
        price_snapshot,
        billing_interval_snapshot
      `)
      .eq("studio_id", studioId)
      .eq("client_id", id)
      .in("status", ["active", "past_due", "unpaid", "pending"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    supabase
      .from("event_registrations")
      .select(`
        id,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        status,
        payment_status,
        quantity,
        unit_price,
        total_price,
        total_amount,
        currency,
        registration_source,
        source,
        notes,
        created_at,
        checked_in_at,
        promoted_from_waitlist_at,
        event_ticket_types ( name ),
        events (
          id,
          name,
          slug,
          start_date,
          end_date
        )
      `)
      .eq("client_id", id)
      .order("created_at", { ascending: false })
      .limit(12),


    supabase
      .from("document_assignments")
      .select(`
        id,
        template_id,
        status,
        assigned_at,
        due_at,
        signed_at,
        document_templates (
          title,
          document_type,
          requires_signature,
          is_required
        )
      `)
      .eq("studio_id", studioId)
      .eq("client_id", id)
      .order("assigned_at", { ascending: false })
      .limit(20),

    supabase
      .from("document_templates")
      .select("id, title, document_type, requires_signature, is_required")
      .eq("studio_id", studioId)
      .eq("is_active", true)
      .eq("applies_to", "all_clients")
      .order("title", { ascending: true }),

    supabase
      .from("document_signatures")
      .select("template_id, signed_at")
      .eq("studio_id", studioId)
      .eq("client_id", id),

    supabase
      .from("sms_contact_permissions")
      .select("*")
      .eq("studio_id", studioId)
      .eq("client_id", id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    supabase
      .from("sms_message_logs")
      .select("*")
      .eq("studio_id", studioId)
      .eq("client_id", id)
      .order("created_at", { ascending: false })
      .limit(10),

    supabase
      .from("syllabus_templates")
      .select(`
        id,
        name,
        dance_style,
        level,
        description,
        active,
        syllabus_template_items (
          id,
          title,
          category,
          description,
          sort_order,
          active
        )
      `)
      .eq("studio_id", studioId)
      .order("name", { ascending: true }),

    supabase
      .from("client_syllabus_assignments")
      .select(`
        id,
        syllabus_template_id,
        assigned_at,
        visible_in_portal,
        archived_at,
        syllabus_templates (
          id,
          name,
          dance_style,
          level,
          description,
          active,
          syllabus_template_items (
            id,
            title,
            category,
            description,
            sort_order,
            active
          )
        ),
        client_syllabus_progress (
          id,
          template_item_id,
          status,
          notes,
          show_notes_in_portal,
          updated_at
        )
      `)
      .eq("studio_id", studioId)
      .eq("client_id", id)
      .order("assigned_at", { ascending: false }),
  ]);

  if (clientError || !client) {
    notFound();
  }

  if (studioError || !studio) {
    throw new Error(`Failed to load studio: ${studioError?.message ?? "Studio not found"}`);
  }
  if (instructorsError) throw new Error(`Failed to load instructors: ${instructorsError.message}`);
  if (packagesError) throw new Error(`Failed to load client packages: ${packagesError.message}`);
  if (upcomingError) throw new Error(`Failed to load upcoming appointments: ${upcomingError.message}`);
  if (recentError) throw new Error(`Failed to load recent appointments: ${recentError.message}`);
  if (paymentsError) throw new Error(`Failed to load payments: ${paymentsError.message}`);
  if (ledgerError) throw new Error(`Failed to load lesson ledger: ${ledgerError.message}`);
  if (accountLedgerError) throw new Error(`Failed to load client account ledger: ${accountLedgerError.message}`);
  if (leadActivitiesError) throw new Error(`Failed to load lead activities: ${leadActivitiesError.message}`);
  if (packageTemplatesError) throw new Error(`Failed to load package templates: ${packageTemplatesError.message}`);
  if (membershipPlansError) throw new Error(`Failed to load membership plans: ${membershipPlansError.message}`);
  if (activeMembershipError) throw new Error(`Failed to load active membership: ${activeMembershipError.message}`);
  if (eventRegistrationsError) throw new Error(`Failed to load event registrations: ${eventRegistrationsError.message}`);
  if (documentAssignmentsError) throw new Error(`Failed to load document assignments: ${documentAssignmentsError.message}`);
  if (allClientDocumentTemplatesError) throw new Error(`Failed to load document templates: ${allClientDocumentTemplatesError.message}`);
  if (documentSignaturesError) throw new Error(`Failed to load document signatures: ${documentSignaturesError.message}`);
  if (smsPermissionError) throw new Error(`Failed to load SMS consent: ${smsPermissionError.message}`);
  if (smsMessagesError) throw new Error(`Failed to load SMS message history: ${smsMessagesError.message}`);
  if (syllabusTemplatesError) throw new Error(`Failed to load syllabus templates: ${syllabusTemplatesError.message}`);
  if (syllabusAssignmentsError) throw new Error(`Failed to load client syllabus progress: ${syllabusAssignmentsError.message}`);

  const { data: automationActionsData, error: automationActionsError } = await supabase
    .from("automation_actions")
    .select(`
      id,
      rule_key,
      title,
      body,
      status,
      priority,
      related_table,
      related_id,
      due_at,
      completed_at,
      dismissed_at,
      created_at,
      updated_at
    `)
    .eq("studio_id", studioId)
    .eq("client_id", id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (automationActionsError) {
    throw new Error(`Failed to load automation activity: ${automationActionsError.message}`);
  }

  const automationActionIds = (automationActionsData ?? []).map((action) => action.id);
  let automationDeliveriesData: ClientAutomationDeliveryRow[] = [];

  if (automationActionIds.length > 0) {
    const { data: deliveryRows, error: automationDeliveriesError } = await supabase
      .from("outbound_deliveries")
      .select(`
        id,
        template_key,
        recipient_email,
        subject,
        status,
        error_message,
        sent_at,
        created_at,
        related_id
      `)
      .eq("studio_id", studioId)
      .eq("related_table", "automation_actions")
      .in("related_id", automationActionIds)
      .order("created_at", { ascending: false });

    if (automationDeliveriesError) {
      throw new Error(`Failed to load automation email activity: ${automationDeliveriesError.message}`);
    }

    automationDeliveriesData = (deliveryRows ?? []) as ClientAutomationDeliveryRow[];
  }

  const typedStudio = studio as StudioRecord & { timezone?: string | null };
  const studioTimeZone =
    typeof typedStudio.timezone === "string" && typedStudio.timezone.trim()
      ? typedStudio.timezone.trim()
      : CLIENT_DETAIL_DEFAULT_TIME_ZONE;
  const typedClient = client as ClientRecord;
  const typedInstructors = (instructors ?? []) as InstructorOption[];
  const typedPackages = (packages ?? []) as ClientPackageRow[];
  const typedUpcoming = (upcomingAppointments ?? []) as AppointmentRow[];
  const typedRecent = (recentAppointments ?? []) as AppointmentRow[];
  const unpaidPayAsYouGoLessons = [...typedUpcoming, ...typedRecent]
    .filter((appointment) => {
      const paymentStatus = (appointment.payment_status ?? "unpaid").toLowerCase();
      return (
        appointment.billing_type === "pay_as_you_go" &&
        paymentStatus !== "paid" &&
        paymentStatus !== "waived" &&
        appointment.status !== "cancelled" &&
        appointment.status !== "canceled"
      );
    })
    .sort(
      (a, b) =>
        new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime(),
    )
    .slice(0, 8);
  const typedPayments = (payments ?? []) as PaymentRow[];
  const typedLedger = (ledger ?? []) as LedgerRow[];
  const typedAccountLedger = (accountLedger ?? []) as ClientAccountLedgerRow[];
  const accountLedgerPreview = typedAccountLedger.slice(0, 20);
  const typedLeadActivities = (leadActivities ?? []) as LeadActivityRow[];
  const typedAutomationActions = (automationActionsData ?? []) as ClientAutomationActionRow[];
  const typedAutomationDeliveries = automationDeliveriesData;
  const automationDeliveryByActionId = new Map(
    typedAutomationDeliveries.map((delivery) => [delivery.related_id, delivery])
  );
  const typedPackageTemplates = (packageTemplates ?? []) as PackageTemplateRow[];
  const typedMembershipPlans = (membershipPlans ?? []) as MembershipPlanOption[];
  const typedActiveMembershipBase: ActiveMembership | null = activeMembership
    ? {
        ...(activeMembership as Omit<ActiveMembership, 'benefits'>),
        benefits: ((activeMembership as { benefits?: MembershipBenefit[] | null }).benefits ?? []) as MembershipBenefit[],
      }
    : null;
  const typedEventRegistrations = (eventRegistrations ?? []) as EventRegistrationRow[];
  const typedDocumentAssignments = (documentAssignments ?? []) as ClientDocumentAssignmentRow[];
  const typedAllClientDocumentTemplates = (allClientDocumentTemplates ?? []) as AllClientDocumentTemplateRow[];
  const typedDocumentSignatures = (documentSignatures ?? []) as ClientDocumentSignatureRow[];
  const typedSmsPermission = (smsPermission as SmsPermissionRow | null) ?? null;
  const typedSmsMessages = (smsMessages ?? []) as SmsMessageLogRow[];
  const typedSyllabusTemplates = (syllabusTemplates ?? []) as SyllabusTemplateRow[];
  const typedSyllabusAssignments = (syllabusAssignments ?? []) as ClientSyllabusAssignmentRow[];

  const portalAdminStatus = canEditClients(role)
    ? await loadClientPortalAdminStatus(typedClient, studioId)
    : null;
  const portalAuthUser = portalAdminStatus?.linkedAuthUser ?? portalAdminStatus?.matchingAuthUser ?? null;
  const portalProfile = portalAdminStatus?.linkedProfile ?? portalAdminStatus?.matchingProfile ?? null;
  const hasConfirmedPortalEmail = !!portalAuthUser?.email_confirmed_at;
  const hasSignedIntoPortal = !!portalAuthUser?.last_sign_in_at;
  const portalInviteDeliveries = portalAdminStatus?.inviteDeliveries ?? [];
  const latestPortalInviteDelivery = portalInviteDeliveries[0] ?? null;
  const hasPortalInviteDelivery = portalInviteDeliveries.length > 0;
  const hasSuccessfulPortalInviteDelivery = portalInviteDeliveries.some(
    (delivery) => delivery.status === "sent" || !!delivery.sent_at || !!delivery.provider_message_id
  );
  const hasFailedPortalInviteDelivery = latestPortalInviteDelivery?.status === "failed";
  const portalInviteDeliveryLabel = !typedClient.email
    ? "No Client Email"
    : hasFailedPortalInviteDelivery
      ? "Last Invite Failed"
      : hasSuccessfulPortalInviteDelivery
        ? "Invite Sent"
        : hasPortalInviteDelivery
          ? "Invite Queued"
          : "No Invite Recorded";
  const hasAuthForClientEmail = !!portalAdminStatus?.matchingAuthUser;
  const hasProfileForClientEmail = !!portalAdminStatus?.matchingProfile;
  const hasUnlinkedAuthUser = !typedClient.portal_user_id && hasAuthForClientEmail;
  const hasUnlinkedProfile = !typedClient.portal_user_id && hasProfileForClientEmail;
  const hasLinkedProfileMismatch =
    !!typedClient.portal_user_id &&
    !!portalProfile?.email &&
    !!typedClient.email &&
    portalProfile.email.toLowerCase() !== typedClient.email.toLowerCase();

  const { data: linkedRelationship, error: linkedRelationshipError } = await supabase
    .from("client_relationships")
    .select("client_id, related_client_id, relationship_type")
    .eq("studio_id", studioId)
    .or(`client_id.eq.${id},related_client_id.eq.${id}`)
    .in("relationship_type", ["partner", "spouse"])
    .limit(1)
    .maybeSingle();

  if (linkedRelationshipError) {
    throw new Error(`Failed to load linked partner: ${linkedRelationshipError.message}`);
  }

  let linkedPartner: LinkedPartnerRecord | null = null;
  let linkedPartnerRelationshipType: string | null = null;

  if (linkedRelationship) {
    const relationship = linkedRelationship as LinkedRelationshipRow;
    const linkedPartnerId =
      relationship.client_id === id
        ? relationship.related_client_id
        : relationship.client_id;

    linkedPartnerRelationshipType = relationship.relationship_type;

    const { data: linkedPartnerRow, error: linkedPartnerError } = await supabase
      .from("clients")
      .select("id, first_name, last_name, status")
      .eq("studio_id", studioId)
      .eq("id", linkedPartnerId)
      .maybeSingle();

    if (linkedPartnerError) {
      throw new Error(`Failed to load linked partner client: ${linkedPartnerError.message}`);
    }

    linkedPartner = (linkedPartnerRow as LinkedPartnerRecord | null) ?? null;
  }

  const { data: partnerCandidatesRows, error: partnerCandidatesError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, status")
    .eq("studio_id", studioId)
    .neq("id", id)
    .in("status", ["active", "lead"])
    .order("first_name", { ascending: true });

  if (partnerCandidatesError) {
    throw new Error(`Failed to load partner candidates: ${partnerCandidatesError.message}`);
  }

  const partnerCandidates = (partnerCandidatesRows as LinkedPartnerRecord[] | null) ?? [];

  let typedActiveMembership: ActiveMembership | null = typedActiveMembershipBase;

  if (typedActiveMembershipBase?.membership_plan_id) {
    const { data: membershipBenefits, error: membershipBenefitsError } = await supabase
      .from("membership_plan_benefits")
      .select(`
        benefit_type,
        quantity,
        discount_percent,
        discount_amount,
        usage_period,
        applies_to
      `)
      .eq("membership_plan_id", typedActiveMembershipBase.membership_plan_id)
      .order("sort_order", { ascending: true });

    if (membershipBenefitsError) {
      throw new Error(`Failed to load membership benefits: ${membershipBenefitsError.message}`);
    }

    typedActiveMembership = {
      ...typedActiveMembershipBase,
      benefits: (membershipBenefits ?? []) as MembershipBenefit[],
    };
  }

  const eventRegistrationIds = typedEventRegistrations.map((row) => row.id);
  let attendanceRows: AttendanceRecordRow[] = [];

  if (eventRegistrationIds.length > 0) {
    const { data: attendanceData, error: attendanceError } = await supabase
      .from("attendance_records")
      .select(`
        id,
        event_registration_id,
        status,
        checked_in_at,
        marked_attended_at
      `)
      .in("event_registration_id", eventRegistrationIds);

    if (attendanceError) {
      throw new Error(`Failed to load event attendance: ${attendanceError.message}`);
    }

    attendanceRows = (attendanceData ?? []) as AttendanceRecordRow[];
  }

  const attendanceByRegistrationId = new Map(
    attendanceRows.map((row) => [row.event_registration_id, row])
  );

  const membershipPayments = typedPayments.filter(isMembershipPayment);
  const latestMembershipPayment = getLatestMembershipPayment(membershipPayments);
  const delinquencyConfig = getDelinquencyConfig(typedActiveMembership);
  const membershipRecovered = hasRecoveredMembershipBilling(
    typedActiveMembership,
    membershipPayments
  );
  const activePackages = typedPackages.filter((p) => p.active);
  const nextAppointment = typedUpcoming[0];
  const lastAppointment = typedRecent[0];
  const upcomingPreviewAppointments = typedUpcoming.slice(0, 5);
  const recentPreviewAppointments = typedRecent.slice(0, 5);
  const paidPayments = typedPayments.filter((payment) => payment.status === "paid");
  const totalPaid = paidPayments.reduce(
    (sum, payment) => sum + Number(payment.amount ?? 0),
    0
  );
  const accountCreditTotal = typedAccountLedger
    .filter((entry) => entry.direction === "credit")
    .reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0);
  const accountDebitTotal = typedAccountLedger
    .filter((entry) => entry.direction === "debit")
    .reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0);
  const accountNetBalance = accountCreditTotal - accountDebitTotal;
  const accountBalanceLabel =
    accountNetBalance > 0
      ? "Available Credit"
      : accountNetBalance < 0
        ? "Balance Owed"
        : "Settled";

  const isPublicIntroLead = typedClient.referral_source === "public_intro_booking";
  const isEventRegistrationLead = typedClient.referral_source === "event_registration";
  const isIndependentInstructor = !!typedClient.is_independent_instructor;
  const hasPortalLogin = !!typedClient.portal_user_id;
  const linkedInstructorName = getLinkedInstructorName(
    typedInstructors,
    typedClient.linked_instructor_id
  );
  const recommendedLeadNextStep = leadRecommendedNextStep({
    isPublicIntroLead,
    isEventRegistrationLead,
  });

  const upcomingFloorRentals = typedUpcoming.filter((item) =>
    isFloorRental(item.appointment_type)
  );
  const recentFloorRentals = typedRecent.filter((item) =>
    isFloorRental(item.appointment_type)
  );
  const lessonUpcomingCount = typedUpcoming.filter(
    (item) => !isFloorRental(item.appointment_type)
  ).length;
  const rentalUpcomingCount = upcomingFloorRentals.length;

  const paidEventRegistrationCount = typedEventRegistrations.filter(
    (row) => row.payment_status === "paid"
  ).length;
  const attendedEventCount = typedEventRegistrations.filter((row) => {
    const attendance = attendanceByRegistrationId.get(row.id);
    return attendance?.status === "attended";
  }).length;
  const signedTemplateIds = new Set(
    typedDocumentSignatures
      .filter((row) => row.signed_at)
      .map((row) => row.template_id),
  );
  const assignedTemplateIds = new Set(typedDocumentAssignments.map((row) => row.template_id));
  const globalDocumentStatusRows = typedAllClientDocumentTemplates
    .filter((template) => !assignedTemplateIds.has(template.id))
    .map((template) => ({
      id: template.id,
      title: template.title,
      documentType: template.document_type ?? "document",
      requiresSignature: Boolean(template.requires_signature),
      isRequired: Boolean(template.is_required),
      status: signedTemplateIds.has(template.id) ? "signed" : "available",
      assignedAt: null as string | null,
      dueAt: null as string | null,
      signedAt: typedDocumentSignatures.find((row) => row.template_id === template.id)?.signed_at ?? null,
      source: "All clients",
    }));
  const assignedDocumentStatusRows = typedDocumentAssignments.map((assignment) => {
    const template = getDocumentTemplateValue(assignment.document_templates);
    return {
      id: assignment.id,
      title: template?.title ?? "Document",
      documentType: template?.document_type ?? "document",
      requiresSignature: Boolean(template?.requires_signature),
      isRequired: Boolean(template?.is_required),
      status: assignment.status,
      assignedAt: assignment.assigned_at,
      dueAt: assignment.due_at,
      signedAt: assignment.signed_at,
      source: "Assigned",
    };
  });
  const documentStatusRows = [...assignedDocumentStatusRows, ...globalDocumentStatusRows];
  const requiredDocumentCount = documentStatusRows.filter((row) => row.isRequired).length;
  const pendingRequiredDocumentCount = documentStatusRows.filter(
    (row) => row.isRequired && row.status !== "signed" && row.status !== "completed",
  ).length;


  return (
    <div className="space-y-8">
      {banner ? (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            banner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {banner.message}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-[linear-gradient(135deg,#0d1536_0%,#111b45_48%,#5b145e_100%)] p-5 text-white shadow-sm md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
              DanceFlow Client Workspace
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">
              Manage the full client relationship in one place
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/75">
              Keep payments, packages, memberships, appointments, portal access, and follow-up tasks connected so the front desk can move quickly with fewer clicks.
            </p>
          </div>
          <div className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-sm text-white/80">
            <p className="font-semibold text-white">Studio CRM</p>
            <p className="mt-1">Built for daily studio operations</p>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-[linear-gradient(135deg,rgba(255,255,255,0.94)_0%,rgba(255,249,243,0.98)_100%)] p-6 shadow-sm">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                Client Profile
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <h2 className="text-3xl font-semibold tracking-tight text-[var(--brand-text)] sm:text-4xl">
                  {typedClient.first_name} {typedClient.last_name}
                </h2>

                <span
                  className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${statusBadgeClass(
                    typedClient.status
                  )}`}
                >
                  {typedClient.status}
                </span>

                {typedClient.skill_level ? (
                  <span className="inline-flex rounded-full bg-[var(--brand-accent-soft)] px-3 py-1 text-sm font-medium text-[var(--brand-accent-dark)]">
                    {typedClient.skill_level}
                  </span>
                ) : null}

                {typedClient.referral_source ? (
                  <span
                    className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${leadSourceBadgeClass(
                      typedClient.referral_source
                    )}`}
                  >
                    {leadSourceLabel(typedClient.referral_source)}
                  </span>
                ) : null}

                {isIndependentInstructor ? (
                  <span className="inline-flex rounded-full bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700">
                    Independent Instructor
                  </span>
                ) : null}
              </div>

              <p className="mt-3 text-sm text-slate-600">
                Client profile, balances, memberships, appointments, payments, and instructor access settings.
              </p>

              <div className="mt-4 rounded-2xl border border-[var(--brand-border)] bg-white/80 px-4 py-3 shadow-sm">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {linkedPartnerRelationshipType === "spouse"
                        ? "Linked Spouse"
                        : "Linked Partner"}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      {linkedPartner
                        ? `${linkedPartner.first_name} ${linkedPartner.last_name}`
                        : "No partner linked yet."}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {linkedPartner ? (
                      <>
                        <Link
                          href={`/app/clients/${linkedPartner.id}`}
                          className="rounded-2xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm hover:bg-[var(--brand-primary-soft)]"
                        >
                          View Profile
                        </Link>

                        <Link
                          href={`/app/schedule/new?clientId=${typedClient.id}`}
                          className="rounded-2xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm hover:bg-[var(--brand-primary-soft)]"
                        >
                          Book Couple Lesson
                        </Link>

                        <form action={unlinkPartnerAction}>
                          <input type="hidden" name="clientId" value={typedClient.id} />
                          <input type="hidden" name="partnerClientId" value={linkedPartner.id} />
                          <input type="hidden" name="returnTo" value={`/app/clients/${typedClient.id}`} />
                          <button
                            type="submit"
                            className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 hover:bg-rose-100"
                          >
                            Unlink Partner
                          </button>
                        </form>
                      </>
                    ) : null}
                  </div>
                </div>

                {!linkedPartner ? (
                  <form action={linkPartnerAction} className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_auto]">
                    <input type="hidden" name="clientId" value={typedClient.id} />
                    <input type="hidden" name="returnTo" value={`/app/clients/${typedClient.id}`} />

                    <div>
                      <label className="mb-1 block text-sm font-medium text-slate-700">
                        Select partner
                      </label>
                      <select
                        name="partnerClientId"
                        className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm"
                        defaultValue=""
                      >
                        <option value="">Choose a client…</option>
                        {partnerCandidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.first_name} {candidate.last_name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block text-sm font-medium text-slate-700">
                        Relationship
                      </label>
                      <select
                        name="relationshipType"
                        className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm"
                        defaultValue="partner"
                      >
                        <option value="partner">Partner</option>
                        <option value="spouse">Spouse</option>
                      </select>
                    </div>

                    <div className="flex items-end">
                      <button
                        type="submit"
                        className="w-full rounded-2xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-medium text-white hover:brightness-105"
                      >
                        Link Partner
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:flex xl:max-w-xl xl:flex-wrap xl:justify-end">
              {canEditClients(role) ? (
                <Link
                  href={`/app/clients/${typedClient.id}/edit`}
                  className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 hover:bg-[var(--brand-primary-soft)]"
                >
                  Edit Client
                </Link>
              ) : null}

              {canCreateAppointments(role) ? (
                <Link
                  href={`/app/schedule/new?clientId=${typedClient.id}`}
                  className="rounded-2xl bg-[linear-gradient(135deg,#0d1536_0%,#111b45_50%,#5b145e_100%)] px-4 py-2 text-white hover:brightness-105"
                >
                  Book Lesson
                </Link>
              ) : null}

              {typedClient.status === "lead" ? (
                <>
                  <form action={convertLeadToActiveAction}>
                    <input type="hidden" name="clientId" value={typedClient.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <button
                      type="submit"
                      className="rounded-2xl bg-green-600 px-4 py-2 text-white hover:bg-green-700"
                    >
                      Convert to Active
                    </button>
                  </form>

                  <form action={archiveLeadAction}>
                    <input type="hidden" name="clientId" value={typedClient.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <button
                      type="submit"
                      className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 hover:bg-[var(--brand-primary-soft)]"
                    >
                      Archive Lead
                    </button>
                  </form>
                </>
              ) : null}
            </div>
          </div>

          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 2xl:grid-cols-4">
            <div className="min-w-0">
              <p className="text-sm text-slate-500">Email</p>
              <p className="mt-1 break-words font-medium text-[var(--brand-text)]">
                {typedClient.email ?? "—"}
              </p>
            </div>

            <div className="min-w-0">
              <p className="text-sm text-slate-500">Phone</p>
              <p className="mt-1 break-words font-medium text-[var(--brand-text)]">
                {typedClient.phone ?? "—"}
              </p>
            </div>

            <div className="min-w-0">
              <p className="text-sm text-slate-500">Birthday</p>
              <p className="mt-1 break-words font-medium text-[var(--brand-text)]">
                {formatClientBirthday(typedClient.birthday)}
              </p>
            </div>

            <div className="min-w-0">
              <p className="text-sm text-slate-500">Mailing Address</p>
              <div className="mt-1 space-y-0.5 break-words font-medium text-[var(--brand-text)]">
                {formatMailingAddress(typedClient).map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </div>

            <div className="min-w-0">
              <p className="text-sm text-slate-500">Dance Interests</p>
              <p className="mt-1 break-words font-medium text-[var(--brand-text)]">
                {typedClient.dance_interests ?? "—"}
              </p>
            </div>

            <div className="min-w-0">
              <p className="text-sm text-slate-500">Referral Source</p>
              <p className="mt-1 break-words font-medium text-[var(--brand-text)]">
                {typedClient.referral_source ? leadSourceLabel(typedClient.referral_source) : "—"}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-[28px] border border-[var(--brand-border)] bg-white/92 p-3 shadow-sm">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {clientDetailTabs.map((tab) => {
            const isActive = tab.id === activeTab;

            return (
              <Link
                key={tab.id}
                href={`/app/clients/${typedClient.id}?tab=${tab.id}`}
                className={`whitespace-nowrap rounded-2xl px-4 py-2 text-sm font-medium transition ${
                  isActive
                    ? "bg-[var(--brand-primary)] text-white shadow-sm"
                    : "border border-[var(--brand-border)] bg-white text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
        <p className="mt-2 px-1 text-xs leading-5 text-slate-500">
          {activeTabInfo.description}
        </p>
      </div>

      {activeTab === "marketing" ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="space-y-6">
            <SectionCard
              title="Client Follow-Up"
              subtitle="Keep follow-up notes and outreach context close to the client record."
              action={
                <span className="rounded-full bg-[var(--brand-accent-soft)] px-3 py-1 text-xs font-medium text-[var(--brand-accent-dark)]">
                  Relationship tools
                </span>
              }
            >
              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="font-medium text-[var(--brand-text)]">Use this tab for consent-based outreach.</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Review SMS permission, send one-to-one texts to opted-in clients, and keep recent communication history in view before the next follow-up.
                </p>
              </div>
            </SectionCard>

            <ClientSmsConsentCard
              clientId={typedClient.id}
              phone={typedClient.phone}
              permission={typedSmsPermission}
              canManage={canEditClients(role)}
              message={query.sms_consent === "updated" ? "SMS consent saved." : null}
              error={query.sms_error ?? null}
            />
          </div>

          <div className="space-y-6">
            <ClientSendSmsCard
              clientId={typedClient.id}
              phone={typedClient.phone}
              permission={typedSmsPermission}
              canManage={canEditClients(role)}
            />

            <ClientSmsMessageHistoryCard messages={typedSmsMessages} />
          </div>
        </div>
      ) : null}


      {activeTab === "documents" ? (
        <SectionCard
          title="Client Documents"
          subtitle="Track waivers, policies, agreements, and other documents connected to this client."
          action={
            <Link
              href="/app/documents"
              className="rounded-2xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm font-medium text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
            >
              Manage Templates
            </Link>
          }
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
              <p className="text-sm text-slate-500">Documents</p>
              <p className="mt-2 text-2xl font-semibold text-[var(--brand-text)]">
                {documentStatusRows.length}
              </p>
            </div>
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
              <p className="text-sm text-slate-500">Required</p>
              <p className="mt-2 text-2xl font-semibold text-[var(--brand-text)]">
                {requiredDocumentCount}
              </p>
            </div>
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
              <p className="text-sm text-slate-500">Needs Signature</p>
              <p className={`mt-2 text-2xl font-semibold ${pendingRequiredDocumentCount > 0 ? "text-amber-700" : "text-green-700"}`}>
                {pendingRequiredDocumentCount}
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {documentStatusRows.length ? (
              documentStatusRows.map((document) => (
                <div
                  key={`${document.source}-${document.id}`}
                  className="rounded-2xl border border-[var(--brand-border)] bg-white p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-[var(--brand-text)]">
                          {document.title}
                        </p>
                        <span className="rounded-full bg-[var(--brand-soft-bg)] px-3 py-1 text-xs font-semibold text-[var(--brand-muted)]">
                          {document.documentType.replaceAll("_", " ")}
                        </span>
                        {document.isRequired ? (
                          <span className="rounded-full bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700">
                            Required
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-2 text-sm text-slate-500">
                        {document.source}
                        {document.dueAt ? ` · Due ${fmtShortDate(document.dueAt)}` : ""}
                        {document.signedAt ? ` · Signed ${fmtShortDate(document.signedAt)}` : ""}
                      </p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${documentStatusClass(document.status)}`}>
                      {document.status === "available"
                        ? document.requiresSignature
                          ? "Ready to Sign"
                          : "Available"
                        : documentStatusLabel(document.status)}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] p-6 text-center">
                <p className="text-sm font-semibold text-[var(--brand-text)]">
                  No documents assigned yet
                </p>
                <p className="mt-2 text-sm text-[var(--brand-muted)]">
                  Assign a waiver, policy, or agreement from the Documents page.
                </p>
              </div>
            )}
          </div>
        </SectionCard>
      ) : null}

      {activeTab === "syllabus" ? (
        <ClientSyllabusTab
          clientId={typedClient.id}
          clientName={`${typedClient.first_name} ${typedClient.last_name}`}
          canEdit={canEditClients(role)}
          templates={typedSyllabusTemplates}
          assignments={typedSyllabusAssignments}
        />
      ) : null}

      {activeTab === "overview" && typedClient.status === "lead" ? (
        <SectionCard
          title="Lead Conversion"
          subtitle="A front-desk focused workflow for moving this lead into their first booked and paid service."
          action={
            <span className="inline-flex rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
              Lead record
            </span>
          }
        >
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Lead Source</p>
              <div className="mt-2">
                <span
                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${leadSourceBadgeClass(
                    typedClient.referral_source
                  )}`}
                >
                  {leadSourceLabel(typedClient.referral_source)}
                </span>
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Current Status</p>
              <p className="mt-2 font-semibold capitalize text-[var(--brand-text)]">
                {typedClient.status}
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Portal Access</p>
              <p className="mt-2 font-semibold text-[var(--brand-text)]">
                {hasPortalLogin ? "Enabled" : "Not yet created"}
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50 p-4">
            <p className="text-sm font-medium text-blue-800">Recommended next step</p>
            <p className="mt-1 text-sm text-blue-900">{recommendedLeadNextStep}</p>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {canCreateAppointments(role) ? (
              <Link
                href={`/app/schedule/new?clientId=${typedClient.id}&appointmentType=intro_lesson`}
                className="rounded-2xl bg-[linear-gradient(135deg,#0d1536_0%,#111b45_50%,#5b145e_100%)] px-4 py-3 text-center text-sm font-medium text-white hover:brightness-105"
              >
                Book Intro Lesson
              </Link>
            ) : null}

            {canCreateAppointments(role) ? (
              <Link
                href={`/app/schedule/new?clientId=${typedClient.id}&appointmentType=private_lesson`}
                className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-center text-sm font-medium hover:bg-[var(--brand-primary-soft)]"
              >
                Book First Private
              </Link>
            ) : null}

            <a
              href="#quick-sale-payment"
              className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-center text-sm font-medium hover:bg-[var(--brand-primary-soft)]"
            >
              Sell Intro Package
            </a>

            <Link
              href={`/app/memberships?clientId=${typedClient.id}`}
              className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-center text-sm font-medium hover:bg-[var(--brand-primary-soft)]"
            >
              Start Membership
            </Link>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <Link
              href={`/app/events?clientId=${typedClient.id}`}
              className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-center text-sm font-medium hover:bg-[var(--brand-primary-soft)]"
            >
              Register for Event
            </Link>

            <form action={convertLeadToActiveAction}>
              <input type="hidden" name="clientId" value={typedClient.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <button
                type="submit"
                className="w-full rounded-2xl bg-green-600 px-4 py-3 text-sm font-medium text-white hover:bg-green-700"
              >
                Convert to Active
              </button>
            </form>

            <form action={archiveLeadAction}>
              <input type="hidden" name="clientId" value={typedClient.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <button
                type="submit"
                className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm font-medium hover:bg-[var(--brand-primary-soft)]"
              >
                Archive Lead
              </button>
            </form>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl bg-[var(--brand-surface)] p-4">
              <p className="text-sm text-slate-500">Suggested flow</p>
              <p className="mt-1 text-sm text-[var(--brand-text)]">
                1. Make contact
                <br />
                2. Book first service
                <br />
                3. Collect payment
                <br />
                4. Convert to active
              </p>
            </div>

            <div className="rounded-2xl bg-[var(--brand-surface)] p-4">
              <p className="text-sm text-slate-500">Best first sale</p>
              <p className="mt-1 text-sm text-[var(--brand-text)]">
                Starter package, intro lesson, event registration, or first private depending on how this lead entered.
              </p>
            </div>

            <div className="rounded-2xl bg-[var(--brand-surface)] p-4">
              <p className="text-sm text-slate-500">Front desk note</p>
              <p className="mt-1 text-sm text-[var(--brand-text)]">
                Use the lead activity timeline to document calls, texts, emails, follow-ups, and objections before conversion.
              </p>
            </div>
          </div>
        </SectionCard>
      ) : null}

      {activeTab === "billing" && delinquencyConfig ? (
        <SectionCard
          title="Membership Billing Warning"
          subtitle="This membership needs staff attention."
          action={
            <span
              className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
                delinquencyConfig.tone === "red"
                  ? "bg-red-50 text-red-700"
                  : "bg-amber-50 text-amber-700"
              }`}
            >
              {typedActiveMembership?.status?.replaceAll("_", " ")}
            </span>
          }
        >
          <div
            className={`rounded-2xl border p-5 ${
              delinquencyConfig.tone === "red"
                ? "border-red-200 bg-red-50"
                : "border-amber-200 bg-amber-50"
            }`}
          >
            <h4
              className={`text-base font-semibold ${
                delinquencyConfig.tone === "red" ? "text-red-900" : "text-amber-900"
              }`}
            >
              {delinquencyConfig.title}
            </h4>

            <p
              className={`mt-2 text-sm ${
                delinquencyConfig.tone === "red" ? "text-red-800" : "text-amber-800"
              }`}
            >
              {delinquencyConfig.message}
            </p>

            <p
              className={`mt-3 text-sm font-medium ${
                delinquencyConfig.tone === "red" ? "text-red-900" : "text-amber-900"
              }`}
            >
              {delinquencyConfig.nextStep}
            </p>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Last Membership Payment</p>
              <p className="mt-1 font-medium text-[var(--brand-text)]">
                {latestMembershipPayment
                  ? fmtCurrency(Number(latestMembershipPayment.amount ?? 0))
                  : "—"}
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Last Payment Date</p>
              <p className="mt-1 font-medium text-[var(--brand-text)]">
                {latestMembershipPayment
                  ? fmtDateTime(latestMembershipPayment.created_at)
                  : "—"}
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Current Period End</p>
              <p className="mt-1 font-medium text-[var(--brand-text)]">
                {typedActiveMembership
                  ? fmtShortDate(typedActiveMembership.current_period_end)
                  : "—"}
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <form action={collectReplacementPaymentMethodAction}>
              <input type="hidden" name="clientId" value={typedClient.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <button
                type="submit"
                className="rounded-2xl bg-[linear-gradient(135deg,#0d1536_0%,#111b45_50%,#5b145e_100%)] px-4 py-2 text-white hover:brightness-105"
              >
                Collect New Payment Method
              </button>
            </form>

            <form action={retryDelinquentMembershipBillingAction}>
              <input
                type="hidden"
                name="clientMembershipId"
                value={typedActiveMembership?.id ?? ""}
              />
              <input type="hidden" name="clientId" value={typedClient.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <button
                type="submit"
                className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 hover:bg-[var(--brand-primary-soft)]"
              >
                Retry Billing
              </button>
            </form>

            <Link
              href="/app/payments"
              className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 hover:bg-[var(--brand-primary-soft)]"
            >
              Review Payments
            </Link>
          </div>
        </SectionCard>
      ) : null}

      {activeTab === "billing" && !delinquencyConfig && membershipRecovered ? (
        <SectionCard
          title="Membership Billing Recovered"
          subtitle="This membership appears to be back in good standing."
          action={
            <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
              Recovered
            </span>
          }
        >
          <div className="rounded-2xl border border-green-200 bg-green-50 p-5">
            <h4 className="text-base font-semibold text-green-900">
              Billing has recovered
            </h4>
            <p className="mt-2 text-sm text-green-800">
              This membership is active and recent payment history indicates billing resumed successfully.
            </p>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Membership Status</p>
              <p className="mt-1 font-medium text-[var(--brand-text)]">
                {typedActiveMembership?.status ?? "—"}
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Latest Membership Payment</p>
              <p className="mt-1 font-medium text-[var(--brand-text)]">
                {latestMembershipPayment
                  ? fmtCurrency(Number(latestMembershipPayment.amount ?? 0))
                  : "—"}
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Latest Payment Date</p>
              <p className="mt-1 font-medium text-[var(--brand-text)]">
                {latestMembershipPayment
                  ? fmtDateTime(latestMembershipPayment.created_at)
                  : "—"}
              </p>
            </div>
          </div>
        </SectionCard>
      ) : null}

            {activeTab === "billing" && typedActiveMembership ? (
          <div id="membership-billing-controls">
          <SectionCard
            title="Membership Billing Controls"
          subtitle="Manage renewal behavior for the current membership."
          action={
            <span
              className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(
                typedActiveMembership.status
              )}`}
            >
              {typedActiveMembership.status}
            </span>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Membership</p>
              <p className="mt-2 font-semibold text-[var(--brand-text)]">
                {typedActiveMembership.name_snapshot}
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Billing</p>
              <p className="mt-2 font-semibold text-[var(--brand-text)]">
                {fmtCurrency(typedActiveMembership.price_snapshot)} /{" "}
                {billingIntervalLabel(typedActiveMembership.billing_interval_snapshot)}
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Current Period</p>
              <p className="mt-2 font-semibold text-[var(--brand-text)]">
                {fmtShortDate(typedActiveMembership.current_period_start)} -{" "}
                {fmtShortDate(typedActiveMembership.current_period_end)}
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Renewal</p>
              <p className="mt-2 font-semibold text-[var(--brand-text)]">
                {typedActiveMembership.cancel_at_period_end
                  ? "Cancels at period end"
                  : typedActiveMembership.auto_renew
                    ? "Auto-renew on"
                    : "Manual / not renewing"}
              </p>
            </div>
          </div>

          {typedActiveMembership.cancel_at_period_end ? (
            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              This membership is set to end on{" "}
              {fmtShortDate(
                typedActiveMembership.ends_on ?? typedActiveMembership.current_period_end
              )}
              .
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-3">
            {!typedActiveMembership.cancel_at_period_end ? (
              <form action={cancelMembershipAtPeriodEndAction}>
                <input
                  type="hidden"
                  name="clientMembershipId"
                  value={typedActiveMembership.id}
                />
                <input type="hidden" name="clientId" value={typedClient.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <button
                  type="submit"
                  className="rounded-2xl border border-red-200 bg-red-50 px-4 py-2 text-red-700 hover:bg-red-100"
                >
                  Cancel at Period End
                </button>
              </form>
            ) : (
              <form action={reactivateMembershipAutoRenewAction}>
                <input
                  type="hidden"
                  name="clientMembershipId"
                  value={typedActiveMembership.id}
                />
                <input type="hidden" name="clientId" value={typedClient.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <button
                  type="submit"
                  className="rounded-2xl border border-green-200 bg-green-50 px-4 py-2 text-green-700 hover:bg-green-100"
                >
                  Turn Auto-Renew Back On
                </button>
              </form>
            )}
          </div>
                  </SectionCard>
        </div>
      ) : null}

      {activeTab === "billing" && typedActiveMembership ? (
        <SectionCard
          title="Membership Billing History"
          subtitle="Recent membership-related charges and invoice activity for this client."
          action={
            membershipPayments.length > 0 ? (
              <span className="rounded-full bg-[var(--brand-accent-soft)] px-3 py-1 text-xs font-medium text-[var(--brand-accent-dark)]">
                {membershipPayments.length} payment{membershipPayments.length === 1 ? "" : "s"}
              </span>
            ) : null
          }
        >
          <div className="space-y-3">
            {membershipPayments.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-6 text-sm text-slate-500">
                No membership payments recorded yet.
              </div>
            ) : (
              membershipPayments.map((payment) => (
                <div
                  key={payment.id}
                  className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-medium text-[var(--brand-text)]">
                      {fmtCurrency(Number(payment.amount ?? 0))}
                    </p>

                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(
                          payment.status
                        )}`}
                      >
                        {payment.status}
                      </span>

                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${paymentSourceBadgeClass(
                          payment.source
                        )}`}
                      >
                        {paymentSourceLabel(payment.source)}
                      </span>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-400">
                        Date
                      </p>
                      <p className="mt-1 text-sm font-medium text-[var(--brand-text)]">
                        {fmtDateTime(payment.created_at)}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-400">
                        Method
                      </p>
                      <p className="mt-1 text-sm font-medium text-[var(--brand-text)]">
                        {paymentMethodLabel(payment.payment_method)}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-400">
                        Payment Type
                      </p>
                      <p className="mt-1 text-sm font-medium text-[var(--brand-text)]">
                        {paymentTypeLabel(payment.payment_type)}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-400">
                        Invoice
                      </p>
                      <p className="mt-1 break-all text-sm font-medium text-[var(--brand-text)]">
                        {payment.stripe_invoice_id ?? "—"}
                      </p>
                    </div>
                  </div>

                  {payment.notes ? (
                    <div className="mt-3 rounded-2xl border border-[var(--brand-border)] bg-white p-3">
                      <p className="text-sm text-slate-600">{payment.notes}</p>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </SectionCard>
      ) : null}

      {activeTab === "overview" && (isEventRegistrationLead || typedEventRegistrations.length > 0) ? (
        <SectionCard
          title="Event Registration Origin"
          subtitle="This client has event-registration history linked into CRM."
          action={
            <span className="inline-flex rounded-full bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700">
              {typedEventRegistrations.length} registration{typedEventRegistrations.length === 1 ? "" : "s"}
            </span>
          }
        >
          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Referral Source</p>
              <div className="mt-2">
                <span
                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${leadSourceBadgeClass(
                    typedClient.referral_source
                  )}`}
                >
                  {leadSourceLabel(typedClient.referral_source)}
                </span>
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Registrations</p>
              <p className="mt-2 text-xl font-semibold text-[var(--brand-text)] md:text-2xl">
                {typedEventRegistrations.length}
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Paid Registrations</p>
              <p className="mt-2 text-xl font-semibold text-[var(--brand-text)] md:text-2xl">
                {paidEventRegistrationCount}
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="text-sm text-slate-500">Attended Events</p>
              <p className="mt-2 text-xl font-semibold text-[var(--brand-text)] md:text-2xl">
                {attendedEventCount}
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {typedEventRegistrations.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-6 text-sm text-slate-500">
                No linked event registrations found yet.
              </div>
            ) : (
              typedEventRegistrations.map((registration) => {
                const eventValue = getEventValue(registration.events);
                const ticketValue = getTicketValue(registration.event_ticket_types);
                const attendance = attendanceByRegistrationId.get(registration.id);

                return (
                  <div
                    key={registration.id}
                    className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4"
                  >
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-[var(--brand-text)]">
                            {eventValue?.name ?? "Unknown Event"}
                          </p>

                          <span
                            className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(
                              registration.status
                            )}`}
                          >
                            {eventRegistrationStatusLabel(registration.status)}
                          </span>

                          {registration.payment_status ? (
                            <span
                              className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(
                                registration.payment_status
                              )}`}
                            >
                              {registration.payment_status.replaceAll("_", " ")}
                            </span>
                          ) : null}

                          {attendance?.status ? (
                            <span
                              className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(
                                attendance.status
                              )}`}
                            >
                              Attendance: {attendance.status.replaceAll("_", " ")}
                            </span>
                          ) : null}
                        </div>

                        <p className="mt-2 text-sm text-slate-600">
                          Ticket: {ticketValue?.name ?? "No ticket type"} • Qty: {registration.quantity}
                        </p>

                        <p className="mt-1 text-sm text-slate-600">
                          Event dates: {fmtShortDate(eventValue?.start_date ?? null)}
                          {eventValue?.end_date && eventValue.end_date !== eventValue.start_date
                            ? ` - ${fmtShortDate(eventValue.end_date)}`
                            : ""}
                        </p>

                        <p className="mt-1 text-sm text-slate-500">
                          Registered: {fmtDateTime(registration.created_at)}
                        </p>

                        {registration.checked_in_at ? (
                          <p className="mt-1 text-sm text-slate-500">
                            Checked in: {fmtDateTime(registration.checked_in_at)}
                          </p>
                        ) : null}

                        {attendance?.marked_attended_at ? (
                          <p className="mt-1 text-sm text-slate-500">
                            Attended marked: {fmtDateTime(attendance.marked_attended_at)}
                          </p>
                        ) : null}

                        {registration.promoted_from_waitlist_at ? (
                          <p className="mt-1 text-sm text-slate-500">
                            Promoted from waitlist: {fmtDateTime(registration.promoted_from_waitlist_at)}
                          </p>
                        ) : null}
                      </div>

                      <div className="min-w-[220px] space-y-2">
                        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-3">
                          <p className="text-xs uppercase tracking-wide text-slate-400">Amount</p>
                          <p className="mt-1 font-medium text-[var(--brand-text)]">
                            {fmtCurrency(
                              Number(
                                registration.total_amount ??
                                  registration.total_price ??
                                  registration.unit_price ??
                                  0
                              ),
                              registration.currency ?? "USD"
                            )}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-3">
                          <p className="text-xs uppercase tracking-wide text-slate-400">Source</p>
                          <p className="mt-1 font-medium text-[var(--brand-text)]">
                            {registration.registration_source ??
                              registration.source ??
                              "event_registration"}
                          </p>
                        </div>

                        {eventValue?.slug ? (
                          <Link
                            href={`/events/${eventValue.slug}`}
                            className="inline-block text-sm underline"
                          >
                            Open public event page
                          </Link>
                        ) : null}
                      </div>
                    </div>

                    {registration.notes ? (
                      <div className="mt-4 rounded-2xl border border-[var(--brand-border)] bg-white p-3">
                        <p className="text-sm text-slate-600">{registration.notes}</p>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </SectionCard>
      ) : null}

      {activeTab === "billing" ? (
      <div className="grid gap-6 xl:grid-cols-2">
        <div id="memberships">
          <SectionCard
            title="Memberships"
            subtitle="Current recurring membership status and billing details."
            action={
              <Link
                href={`/app/memberships?clientId=${typedClient.id}`}
                className="rounded-2xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm font-medium hover:bg-[var(--brand-primary-soft)]"
              >
                {typedActiveMembership ? "Manage" : "Start"}
              </Link>
            }
          >
            {typedActiveMembership ? (
              <div className="space-y-4">
                <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Current Membership
                      </p>
                      <h4 className="mt-2 text-lg font-semibold text-[var(--brand-text)]">
                        {typedActiveMembership.name_snapshot}
                      </h4>
                    </div>
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                        typedActiveMembership.status
                      )}`}
                    >
                      {typedActiveMembership.status.replaceAll("_", " ")}
                    </span>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl bg-white px-3 py-2">
                      <p className="text-xs text-slate-500">Billing</p>
                      <p className="mt-1 font-semibold text-[var(--brand-text)]">
                        {fmtCurrency(typedActiveMembership.price_snapshot)} / {billingIntervalLabel(typedActiveMembership.billing_interval_snapshot)}
                      </p>
                    </div>
                    <div className="rounded-xl bg-white px-3 py-2">
                      <p className="text-xs text-slate-500">Renewal</p>
                      <p className="mt-1 font-semibold text-[var(--brand-text)]">
                        {typedActiveMembership.cancel_at_period_end
                          ? "Cancels at period end"
                          : typedActiveMembership.auto_renew
                            ? "Auto-renew on"
                            : "Manual renewal"}
                      </p>
                    </div>
                    <div className="rounded-xl bg-white px-3 py-2 sm:col-span-2">
                      <p className="text-xs text-slate-500">Current Period</p>
                      <p className="mt-1 font-semibold text-[var(--brand-text)]">
                        {fmtShortDate(typedActiveMembership.current_period_start)} - {fmtShortDate(typedActiveMembership.current_period_end)}
                      </p>
                    </div>
                  </div>
                </div>

                {typedActiveMembership.benefits.length > 0 ? (
                  <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-4">
                    <p className="text-sm font-medium text-[var(--brand-text)]">
                      Benefits
                    </p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {typedActiveMembership.benefits.map((benefit, index) => (
                        <div
                          key={`${benefit.benefit_type}-${index}`}
                          className="rounded-xl bg-[var(--brand-surface)] px-3 py-2 text-sm text-slate-700"
                        >
                          {benefit.benefit_type.replaceAll("_", " ")}
                          {benefit.quantity != null ? ` • ${benefit.quantity}` : ""}
                          {benefit.discount_percent != null ? ` • ${benefit.discount_percent}% off` : ""}
                          {benefit.discount_amount != null ? ` • ${fmtCurrency(benefit.discount_amount)} off` : ""}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] p-5">
                <p className="font-medium text-[var(--brand-text)]">No active membership</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Use Start Membership when this client is ready for monthly, quarterly, or yearly billing.
                </p>
                <p className="mt-3 text-xs text-slate-500">
                  {typedMembershipPlans.length} active membership plan{typedMembershipPlans.length === 1 ? "" : "s"} available.
                </p>
              </div>
            )}
          </SectionCard>
        </div>

        <div id="package-balances">
          <SectionCard
            title="Packages"
            subtitle="Current package balances and remaining lesson, group class, and practice party credits."
            action={
              <Link href="/app/packages/client-balances" className="text-sm underline">
                View all balances
              </Link>
            }
          >
            <div className="space-y-4">
              {typedPackages.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] p-5">
                  <p className="font-medium text-[var(--brand-text)]">No active packages</p>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Use Quick Sale & Payment to sell this client their first package.
                  </p>
                </div>
              ) : (
                typedPackages.map((pkg) => {
                  const health = getPackageHealth(pkg);
                  const warning = packageWarningMessage(health);

                  return (
                    <div
                      key={pkg.id}
                      className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-3">
                            <p className="font-medium text-[var(--brand-text)]">{pkg.name_snapshot}</p>
                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${packageHealthClass(
                                health
                              )}`}
                            >
                              {packageHealthLabel(health)}
                            </span>
                          </div>

                          <p className="mt-1 text-sm text-slate-500">
                            Expires: {fmtShortDate(pkg.expiration_date)}
                          </p>
                        </div>
                      </div>

                      {warning ? (
                        <div
                          className={`mt-3 rounded-2xl border px-3 py-2 text-sm ${
                            health === "depleted" ||
                            health === "inactive" ||
                            health === "expired"
                              ? "border-red-200 bg-red-50 text-red-800"
                              : "border-amber-200 bg-amber-50 text-amber-800"
                          }`}
                        >
                          {warning}
                        </div>
                      ) : null}

                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        {pkg.client_package_items.length === 0 ? (
                          <p className="text-slate-500">No package items found.</p>
                        ) : (
                          pkg.client_package_items.map((item) => (
                            <div
                              key={item.id}
                              className="rounded-2xl border border-[var(--brand-border)] bg-white p-4"
                            >
                              <p className="text-sm text-slate-500">
                                {usageLabel(item.usage_type)}
                              </p>
                              <p className="mt-2 font-medium text-[var(--brand-text)]">
                                {item.is_unlimited
                                  ? "Unlimited"
                                  : `${item.quantity_remaining} remaining`}
                              </p>
                              <p className="mt-1 text-sm text-slate-600">
                                {item.is_unlimited
                                  ? "No deduction limit"
                                  : `Used ${item.quantity_used} of ${item.quantity_total}`}
                              </p>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </SectionCard>
        </div>
      </div>
      ) : null}

      <div className="space-y-6">
        <div className="space-y-6">
          {activeTab === "overview" ? (
          <SectionCard title="Client Snapshot">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
                <p className="text-sm text-slate-500">Active Packages</p>
                <p className="mt-2 text-xl font-semibold text-[var(--brand-text)] md:text-2xl">
                  {activePackages.length}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
                <p className="text-sm text-slate-500">
                  {isIndependentInstructor ? "Upcoming Bookings" : "Upcoming Lessons"}
                </p>
                <p className="mt-2 text-xl font-semibold text-[var(--brand-text)] md:text-2xl">
                  {typedUpcoming.length}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
                <p className="text-sm text-slate-500">Payments Recorded</p>
                <p className="mt-2 text-xl font-semibold text-[var(--brand-text)] md:text-2xl">
                  {typedPayments.length}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
                <p className="text-sm text-slate-500">Total Paid</p>
                <p className="mt-2 text-xl font-semibold text-[var(--brand-text)] md:text-2xl">
                  {fmtCurrency(totalPaid)}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
                <p className="text-sm text-slate-500">Account Balance</p>
                <p className={`mt-2 text-xl font-semibold md:text-2xl ${
                  accountNetBalance < 0 ? "text-rose-700" : "text-[var(--brand-text)]"
                }`}>
                  {fmtCurrency(Math.abs(accountNetBalance))}
                </p>
                <p className="mt-1 text-xs text-slate-500">{accountBalanceLabel}</p>
              </div>
            </div>

            {nextAppointment ? (
              <div className="mt-5 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="text-sm text-slate-500">Next Appointment</p>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <p className="font-medium text-[var(--brand-text)]">
                    {nextAppointment.title ||
                      appointmentTypeLabel(nextAppointment.appointment_type)}
                  </p>

                  <span
                    className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${appointmentTypeBadgeClass(
                      nextAppointment.appointment_type
                    )}`}
                  >
                    {isFloorRental(nextAppointment.appointment_type)
                      ? "Floor Rental"
                      : appointmentTypeLabel(nextAppointment.appointment_type)}
                  </span>
                </div>

                <p className="mt-1 text-sm text-slate-600">
                  {fmtShortDateTime(nextAppointment.starts_at, studioTimeZone)}
                </p>

                <p className="mt-1 text-sm text-slate-500">
                  {isFloorRental(nextAppointment.appointment_type)
                    ? "No room required • No package deduction"
                    : `${getInstructorName(nextAppointment.instructors)} • ${getRoomName(
                        nextAppointment.rooms
                      )}`}
                </p>
              </div>
            ) : null}
          </SectionCard>
          ) : null}

          {activeTab === "portal" ? (
          <SectionCard
  title="Portal Access"
  subtitle="Invite this client to their student portal and confirm whether they can sign in."
  action={
    canEditClients(role) ? (
      <span className="rounded-full bg-[var(--brand-accent-soft)] px-3 py-1 text-xs font-medium text-[var(--brand-accent-dark)]">
        Staff Managed
      </span>
    ) : null
  }
>
  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
    <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
      <p className="text-sm text-slate-500">Portal Status</p>
      <p className="mt-2 text-lg font-semibold text-[var(--brand-text)]">
        {hasPortalLogin ? "Connected" : hasUnlinkedAuthUser || hasUnlinkedProfile ? "Needs Attention" : "Not Connected"}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        {hasPortalLogin
          ? "This client can use the student portal."
          : hasUnlinkedAuthUser || hasUnlinkedProfile
            ? "A portal sign-in exists for this email and can be connected."
            : "Send an invite so the student can access the portal."}
      </p>
    </div>

    <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
      <p className="text-sm text-slate-500">Student Email</p>
      <p className="mt-2 break-all text-base font-semibold text-[var(--brand-text)]">
        {typedClient.email || "No email on file"}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Students must use this same email address when signing in.
      </p>
    </div>

    <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
      <p className="text-sm text-slate-500">Last Portal Sign-In</p>
      <p className="mt-2 text-lg font-semibold text-[var(--brand-text)]">
        {hasSignedIntoPortal ? fmtPortalDateTime(portalAuthUser?.last_sign_in_at) : "Not yet"}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        {hasSignedIntoPortal ? "The student has accessed the portal." : "No completed portal login is recorded."}
      </p>
    </div>

    <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
      <p className="text-sm text-slate-500">Invite Email</p>
      <p className="mt-2 text-lg font-semibold text-[var(--brand-text)]">
        {portalInviteDeliveryLabel}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        {latestPortalInviteDelivery?.created_at
          ? `Last attempt ${fmtPortalDateTime(latestPortalInviteDelivery.created_at)}`
          : typedClient.email
            ? "No portal invite email is recorded yet."
            : "Add an email before sending a portal invite."}
      </p>
    </div>
  </div>

  {canEditClients(role) ? (
    <div className="mt-5 rounded-2xl border border-[var(--brand-border)] bg-white p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-[var(--brand-text)]">Portal Support Summary</p>
          <p className="mt-1 text-sm text-slate-600">
            Use this panel to confirm whether the student can access the portal and whether their invite email was delivered.
          </p>
        </div>
        <span
          className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold ${
            hasPortalLogin && hasConfirmedPortalEmail
              ? "bg-emerald-50 text-emerald-700"
              : hasUnlinkedAuthUser || hasUnlinkedProfile
                ? "bg-amber-50 text-amber-700"
                : "bg-slate-100 text-slate-700"
          }`}
        >
          {hasPortalLogin && hasConfirmedPortalEmail
            ? "Ready"
            : hasUnlinkedAuthUser || hasUnlinkedProfile
              ? "Action needed"
              : "Invite needed"}
        </span>
      </div>

      {portalAdminStatus?.lookupError ? (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Portal status could not be fully checked. Try refreshing the page or contact DanceFlow support if this continues.
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Connection</p>
          <p className="mt-1 text-sm font-medium text-[var(--brand-text)]">
            {hasPortalLogin
              ? "Connected to the student portal"
              : hasUnlinkedAuthUser || hasUnlinkedProfile
                ? "Ready to connect"
                : "Not connected yet"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {hasPortalLogin
              ? "The student can sign in using the email on this client record."
              : hasUnlinkedAuthUser || hasUnlinkedProfile
                ? "Use Link Existing Account below to finish connecting portal access."
                : "Send a portal invite to start access."}
          </p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Sign-In Email</p>
          <p className="mt-1 text-sm font-medium text-[var(--brand-text)]">
            {hasConfirmedPortalEmail ? "Verified" : portalAuthUser ? "Waiting for student confirmation" : "No sign-in completed yet"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {hasConfirmedPortalEmail
              ? `Verified ${fmtPortalDateTime(portalAuthUser?.email_confirmed_at)}`
              : "The student should open the newest secure sign-in email."}
          </p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:col-span-2">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Recent Portal Email</p>
          <p className="mt-1 text-sm font-medium text-[var(--brand-text)]">
            {portalInviteDeliveryLabel}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {latestPortalInviteDelivery
              ? `${latestPortalInviteDelivery.recipient_email || "No recipient"} · ${latestPortalInviteDelivery.status || "unknown"} · ${fmtPortalDateTime(latestPortalInviteDelivery.created_at)}`
              : "No portal invite email attempt has been recorded for this client yet."}
          </p>
          {latestPortalInviteDelivery?.error_message ? (
            <p className="mt-2 rounded-xl border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              The last invite email failed. Check the student's email address and resend the invite.
            </p>
          ) : null}
        </div>
      </div>

      {portalInviteDeliveries.length > 0 ? (
        <div className="mt-4 rounded-2xl border border-[var(--brand-border)] bg-white p-3">
          <p className="text-sm font-semibold text-[var(--brand-text)]">Recent Portal Emails</p>
          <div className="mt-3 space-y-2">
            {portalInviteDeliveries.map((delivery) => (
              <div
                key={delivery.id}
                className="flex flex-col gap-2 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div>
                  <p className="text-sm font-medium text-[var(--brand-text)]">
                    {delivery.subject || "Portal invite email"}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {delivery.recipient_email || "No recipient"} · {fmtPortalDateTime(delivery.created_at)}
                  </p>
                  {delivery.error_message ? (
                    <p className="mt-1 text-xs text-red-600">Delivery failed. Check the email address and resend.</p>
                  ) : null}
                </div>
                <span
                  className={`inline-flex w-fit rounded-full px-2 py-1 text-xs font-semibold ${
                    delivery.status === "sent" || delivery.sent_at
                      ? "bg-emerald-50 text-emerald-700"
                      : delivery.status === "failed"
                        ? "bg-red-50 text-red-700"
                        : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {delivery.status === "sent" || delivery.sent_at
                    ? "Sent"
                    : delivery.status === "failed"
                      ? "Failed"
                      : "Pending"}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {hasUnlinkedAuthUser || hasUnlinkedProfile ? (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          This student has started portal sign-in with this email, but this client record is not connected yet. Use
          <span className="font-semibold"> Link Existing Account</span> below to finish connecting portal access.
        </div>
      ) : null}

      {hasLinkedProfileMismatch ? (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          The connected portal email does not match this client email. Review the email address before sending another invite.
        </div>
      ) : null}
    </div>
  ) : null}

  <div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50 p-4">
    <p className="text-sm font-medium text-blue-800">Student Portal Link</p>
    <p className="mt-1 break-all text-sm text-blue-900">
      /portal/{typedStudio.slug}
    </p>
    <p className="mt-2 text-xs leading-6 text-blue-700">
      Share this only with students who should access this studio portal. Students should sign in with the same email saved on their client record.
    </p>
  </div>

  {isIndependentInstructor ? (
    <div className="mt-5 grid gap-4 sm:grid-cols-3">
      <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4">
        <p className="text-sm text-indigo-700">Upcoming Floor Rentals</p>
        <p className="mt-2 text-2xl font-semibold text-indigo-900">
          {rentalUpcomingCount}
        </p>
      </div>

      <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4">
        <p className="text-sm text-indigo-700">Upcoming Studio Lessons</p>
        <p className="mt-2 text-2xl font-semibold text-indigo-900">
          {lessonUpcomingCount}
        </p>
      </div>

      <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4">
        <p className="text-sm text-indigo-700">Portal Mode</p>
        <p className="mt-2 text-sm font-semibold text-indigo-900">
          Client + Floor-Rental Access
        </p>
      </div>
    </div>
  ) : null}

  {canEditClients(role) ? (
    <div className="mt-5 rounded-2xl border border-[var(--brand-border)] bg-white p-4">
      <h3 className="text-base font-semibold text-[var(--brand-text)]">
        Portal Access
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        Connect this client to their login account. If they do not have one yet,
        send an invite to create portal access.
      </p>

      <div className="mt-4 space-y-3">
        <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Client Email
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--brand-text)]">
            {typedClient.email || "No email on file"}
          </p>
        </div>

        {hasPortalLogin ? (
          <form action={unlinkPortalAccessAction}>
            <input type="hidden" name="clientId" value={typedClient.id} />
            <input
              type="hidden"
              name="returnTo"
              value={`/app/clients/${typedClient.id}`}
            />
            <button
              type="submit"
              className="w-full rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 hover:bg-red-100"
            >
              Unlink Portal Access
            </button>
          </form>
        ) : (
          <form action={linkPortalAccessAction}>
            <input type="hidden" name="clientId" value={typedClient.id} />
            <input
              type="hidden"
              name="returnTo"
              value={`/app/clients/${typedClient.id}`}
            />
            <button
              type="submit"
              className="w-full rounded-2xl bg-[linear-gradient(135deg,#0d1536_0%,#111b45_50%,#5b145e_100%)] px-4 py-3 text-sm font-medium text-white hover:brightness-105"
            >
              Link Existing Account
            </button>
          </form>
        )}

        {typedClient.email ? (
          <form action={sendPortalInviteAction}>
            <input type="hidden" name="clientId" value={typedClient.id} />
            <input
              type="hidden"
              name="returnTo"
              value={`/app/clients/${typedClient.id}`}
            />
            <button
              type="submit"
              className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm font-medium text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
            >
              Send Portal Invite
            </button>
          </form>
        ) : null}
      </div>
    </div>
  ) : null}
</SectionCard>
          ) : null}

          {activeTab === "notes" ? (
          <SectionCard title="Notes">
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4">
              <p className="whitespace-pre-wrap text-slate-700">
                {typedClient.notes ?? "No notes recorded."}
              </p>
            </div>
          </SectionCard>
          ) : null}

          {activeTab === "notes" ? (
            <SectionCard
              title="Automation Activity"
              subtitle="ARIA and automation suggestions, drafts, sends, and completions tied to this client."
              action={
                <Link
                  href="/app/automations"
                  className="rounded-full border border-[var(--brand-border)] px-3 py-1 text-xs font-semibold text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
                >
                  Open Automations
                </Link>
              }
            >
              <div className="space-y-3">
                {typedAutomationActions.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No automation activity has been recorded for this client yet.
                  </p>
                ) : (
                  typedAutomationActions.map((action) => {
                    const delivery = automationDeliveryByActionId.get(action.id);

                    return (
                      <div
                        key={action.id}
                        className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                              {automationRuleLabel(action.rule_key)}
                            </p>
                            <p className="mt-1 font-semibold text-[var(--brand-text)]">
                              {action.title}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              Created {fmtShortDateTime(action.created_at)}
                              {action.due_at ? ` · Due ${fmtShortDateTime(action.due_at)}` : ""}
                            </p>
                          </div>

                          <div className="flex flex-wrap gap-2">
                            <span
                              className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${automationStatusBadgeClass(
                                action.status,
                              )}`}
                            >
                              {action.status.replaceAll("_", " ")}
                            </span>
                            {action.priority ? (
                              <span className="inline-flex rounded-full bg-white px-2 py-1 text-xs font-semibold text-slate-600">
                                {action.priority}
                              </span>
                            ) : null}
                          </div>
                        </div>

                        {action.body ? (
                          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                            {action.body}
                          </p>
                        ) : null}

                        {delivery ? (
                          <div className="mt-3 rounded-2xl border border-white bg-white/80 p-3 text-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="font-semibold text-[var(--brand-text)]">
                                Email draft / delivery
                              </p>
                              <span
                                className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${deliveryStatusBadgeClass(
                                  delivery.status,
                                )}`}
                              >
                                {delivery.status.replaceAll("_", " ")}
                              </span>
                            </div>

                            <p className="mt-2 text-xs text-slate-500">
                              To: {delivery.recipient_email ?? "No recipient"} · Created{" "}
                              {fmtShortDateTime(delivery.created_at)}
                              {delivery.sent_at ? ` · Sent ${fmtShortDateTime(delivery.sent_at)}` : ""}
                            </p>

                            {delivery.subject ? (
                              <p className="mt-2 text-sm text-slate-700">
                                <span className="font-medium">Subject:</span> {delivery.subject}
                              </p>
                            ) : null}

                            {delivery.error_message ? (
                              <p className="mt-2 text-xs text-red-600">
                                {delivery.error_message}
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
                          {action.completed_at ? <span>Completed {fmtShortDateTime(action.completed_at)}</span> : null}
                          {action.dismissed_at ? <span>Dismissed {fmtShortDateTime(action.dismissed_at)}</span> : null}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </SectionCard>
          ) : null}
        </div>

        <div className="space-y-6">
          {activeTab === "billing" ? (
            <div id="pay-as-you-go-lessons">
              <QuickActionPanel
              title="Pay-as-you-go Lessons"
              description="Collect payment for lessons that need to be paid individually. These payments are linked directly to the lesson."
              defaultOpen={unpaidPayAsYouGoLessons.length > 0}
            >
              {unpaidPayAsYouGoLessons.length > 0 ? (
                <div className="space-y-4">
                  {unpaidPayAsYouGoLessons.map((appointment) => {
                    const lessonAmount = Number(appointment.price_amount ?? 0);
                    const lessonTitle =
                      appointment.title?.trim() ||
                      appointment.appointment_type
                        .replaceAll("_", " ")
                        .replace(/\b\w/g, (letter) => letter.toUpperCase());
                    const lessonReturnTo = `/app/clients/${typedClient.id}?tab=billing#pay-as-you-go-lessons`;

                    return (
                      <form
                        key={appointment.id}
                        action={recordPayAsYouGoLessonPaymentAction}
                        className="rounded-2xl border border-amber-200 bg-amber-50 p-4"
                      >
                        <input type="hidden" name="appointmentId" value={appointment.id} />
                        <input type="hidden" name="clientId" value={typedClient.id} />
                        <input type="hidden" name="returnTo" value={lessonReturnTo} />
                        <input type="hidden" name="paymentSource" value="client_record" />

                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-slate-950">
                              {lessonTitle}
                            </p>
                            <p className="mt-1 text-xs text-slate-600">
                              {fmtShortDateTime(appointment.starts_at, studioTimeZone)} · {getInstructorName(appointment.instructors)}
                            </p>
                            <p className="mt-1 text-xs text-slate-600">
                              This records money and/or account credit directly against this lesson.
                            </p>
                          </div>

                          <Link
                            href={`/app/schedule/${appointment.id}`}
                            className="text-sm font-medium text-[var(--brand-primary)] hover:underline"
                          >
                            Open lesson
                          </Link>
                        </div>

                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          <div>
                            <label className="mb-1 block text-xs font-medium text-slate-700">
                              Lesson price
                            </label>
                            <input
                              name="lessonPrice"
                              type="number"
                              min="0"
                              step="0.01"
                              defaultValue={lessonAmount > 0 ? String(lessonAmount) : ""}
                              className="w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm"
                              placeholder="0.00"
                            />
                          </div>

                          <div>
                            <label className="mb-1 block text-xs font-medium text-slate-700">
                              Money collected today
                            </label>
                            <input
                              name="amount"
                              type="number"
                              min="0"
                              step="0.01"
                              defaultValue={lessonAmount > 0 ? String(lessonAmount) : ""}
                              className="w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm"
                              placeholder="0.00"
                            />
                          </div>

                          <div>
                            <label className="mb-1 block text-xs font-medium text-slate-700">
                              Account credit to apply
                            </label>
                            <input
                              name="accountCreditToApply"
                              type="number"
                              min="0"
                              step="0.01"
                              defaultValue="0"
                              className="w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm"
                              placeholder="0.00"
                            />
                          </div>

                          <div>
                            <label className="mb-1 block text-xs font-medium text-slate-700">
                              Collection method
                            </label>
                            <select
                              name="paymentMethod"
                              defaultValue="card"
                              className="w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm"
                            >
                              <option value="card">Card outside DanceFlow</option>
                              <option value="cash">Cash</option>
                              <option value="check">Check</option>
                              <option value="venmo">Venmo</option>
                              <option value="zelle">Zelle</option>
                              <option value="ach">ACH</option>
                              <option value="other">Other</option>
                            </select>
                          </div>
                        </div>

                        <label className="mt-3 block text-xs font-medium text-slate-700">
                          Payment notes
                          <textarea
                            name="notes"
                            rows={2}
                            className="mt-1 w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm"
                            placeholder="Optional note for this lesson payment."
                          />
                        </label>

                        <button
                          type="submit"
                          className="mt-4 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                        >
                          Record Lesson Payment
                        </button>
                      </form>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                  No unpaid pay-as-you-go lessons were found for this client.
                </div>
              )}
              </QuickActionPanel>
            </div>
          ) : null}

          {activeTab === "billing" ? (
          <div id="quick-sale-payment">
            <QuickActionPanel
              title="Quick Sale & Payment"
              description="Log a payment, attach it to an existing package, or sell a package and take payment without leaving the page."
              defaultOpen={typedClient.status === "lead"}
            >
              <QuickPaymentPanel
                clientId={typedClient.id}
                returnTo={returnTo}
                packages={activePackages.map((pkg) => ({
                  id: pkg.id,
                  name_snapshot: pkg.name_snapshot,
                }))}
                packageTemplates={typedPackageTemplates.map((template) => ({
                  id: template.id,
                  name: template.name,
                  price: template.price,
                }))}
                activeMembership={typedActiveMembership}
                accountCreditBalance={Math.max(accountNetBalance, 0)}
              />
            </QuickActionPanel>
          </div>
          ) : null}

          {activeTab === "billing" && canEditClients(role) ? (
  <QuickActionPanel
    title="Package Count Correction"
    description="Adjust package balances when lesson, group class, or party credits need to be added back or manually deducted. Each correction is saved in package history."
    defaultOpen={false}
  >
              {activePackages.some((pkg) =>
                pkg.client_package_items.some((item) => !item.is_unlimited)
              ) ? (
                <form action={adjustLessonCountCorrectionAction} className="space-y-4">
                  <input type="hidden" name="clientId" value={typedClient.id} />
                  <input
                    type="hidden"
                    name="returnTo"
                    value={`/app/clients/${typedClient.id}`}
                  />

                  <div>
                    <label
                      htmlFor="packageItemId"
                      className="mb-1 block text-sm font-medium text-[var(--brand-text)]"
                    >
                      Package Balance
                    </label>
                    <select
                      id="packageItemId"
                      name="packageItemId"
                      required
                      className="w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm"
                      defaultValue=""
                    >
                      <option value="">Select package balance</option>
                      {activePackages.map((pkg) => (
                        <optgroup key={pkg.id} label={pkg.name_snapshot}>
                          {pkg.client_package_items
                            .filter((item) => !item.is_unlimited)
                            .map((item) => (
                              <option key={item.id} value={item.id}>
                                {pkg.name_snapshot} — {usageLabel(item.usage_type)} — {item.quantity_remaining ?? 0} remaining
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <label
                        htmlFor="correctionType"
                        className="mb-1 block text-sm font-medium text-[var(--brand-text)]"
                      >
                        Correction Type
                      </label>
                      <select
                        id="correctionType"
                        name="correctionType"
                        required
                        className="w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm"
                        defaultValue="add"
                      >
                        <option value="add">Add credits</option>
                        <option value="debit">Debit credits</option>
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="quantity"
                        className="mb-1 block text-sm font-medium text-[var(--brand-text)]"
                      >
                        Quantity
                      </label>
                      <input
                        id="quantity"
                        name="quantity"
                        type="number"
                        min="1"
                        step="1"
                        required
                        className="w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm"
                        placeholder="1"
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="reason"
                      className="mb-1 block text-sm font-medium text-[var(--brand-text)]"
                    >
                      Reason / Notes
                    </label>
                    <textarea
                      id="reason"
                      name="reason"
                      rows={3}
                      required
                      className="w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm"
                      placeholder="Example: Correcting missed deduction, adding a bonus credit, or restoring a credit after a scheduling error."
                    />
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      Add credits increases the selected package balance. Debit credits manually deducts from the remaining balance. Negative balances are not allowed.
                    </p>
                  </div>

                  <button
                    type="submit"
                    className="w-full rounded-2xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-semibold text-white hover:opacity-90"
                  >
                    Save Correction
                  </button>
                </form>
              ) : (
                <p className="text-sm text-slate-500">
                  This client does not have any active package balances that can be corrected.
                </p>
              )}
            </QuickActionPanel>
          ) : null}

          {activeTab === "billing" ? (
          <SectionCard
            title="Account Balance"
            subtitle="Track client-level credits, balances owed, floor fee charges, and truthful account adjustments without changing package history."
            action={
              <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
                accountNetBalance > 0
                  ? "bg-green-50 text-green-700"
                  : accountNetBalance < 0
                    ? "bg-rose-50 text-rose-700"
                    : "bg-slate-100 text-slate-700"
              }`}>
                {accountBalanceLabel}
              </span>
            }
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="text-sm text-slate-500">Available Credit</p>
                <p className="mt-2 text-2xl font-semibold text-green-700">
                  {fmtCurrency(Math.max(accountNetBalance, 0))}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="text-sm text-slate-500">Balance Owed</p>
                <p className="mt-2 text-2xl font-semibold text-rose-700">
                  {fmtCurrency(Math.max(accountDebitTotal - accountCreditTotal, 0))}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="text-sm text-slate-500">Ledger Entries</p>
                <p className="mt-2 text-2xl font-semibold text-[var(--brand-text)]">
                  {typedAccountLedger.length}
                </p>
              </div>
            </div>

            <details className="mt-5 rounded-2xl border border-[var(--brand-border)] bg-white p-4">
              <summary className="cursor-pointer text-sm font-semibold text-[var(--brand-text)]">
                Manage account ledger
              </summary>

              <p className="mt-2 text-sm leading-6 text-slate-600">
                Use this only for client-level financial adjustments such as account credit,
                floor fee balances, debt owed, refund credit, or reversing an incorrect entry.
                Package lesson counts should still be corrected above.
              </p>

              {canEditClients(role) ? (
                <form action={addClientAccountLedgerEntryAction} className="mt-4 grid gap-4">
                  <input type="hidden" name="clientId" value={typedClient.id} />
                  <input type="hidden" name="returnTo" value={`/app/clients/${typedClient.id}`} />

                  <div className="grid gap-4 md:grid-cols-3">
                    <div>
                      <label htmlFor="accountEntryKind" className="mb-1 block text-sm font-medium text-[var(--brand-text)]">
                        Entry Type
                      </label>
                      <select
                        id="accountEntryKind"
                        name="entryKind"
                        required
                        className="w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm"
                        defaultValue="credit_added"
                      >
                        <option value="credit_added">Add account credit</option>
                        <option value="floor_fee_credit">Add floor fee credit</option>
                        <option value="refund_credit">Add refund credit</option>
                        <option value="charge_added">Add balance owed</option>
                        <option value="floor_fee_charge">Add floor fee owed</option>
                        <option value="lesson_charge">Add lesson charge</option>
                        <option value="manual_adjustment_credit">Manual credit adjustment</option>
                        <option value="manual_adjustment_debit">Manual debit adjustment</option>
                        <option value="reversal_credit">Reversal credit</option>
                        <option value="reversal_debit">Reversal debit</option>
                      </select>
                    </div>

                    <div>
                      <label htmlFor="accountAmount" className="mb-1 block text-sm font-medium text-[var(--brand-text)]">
                        Amount
                      </label>
                      <input
                        id="accountAmount"
                        name="amount"
                        type="number"
                        min="0.01"
                        step="0.01"
                        required
                        className="w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm"
                        placeholder="85.00"
                      />
                    </div>

                    <div>
                      <label htmlFor="accountEntryDate" className="mb-1 block text-sm font-medium text-[var(--brand-text)]">
                        Entry Date
                      </label>
                      <input
                        id="accountEntryDate"
                        name="entryDate"
                        type="date"
                        required
                        defaultValue={new Date().toISOString().slice(0, 10)}
                        className="w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="accountDescription" className="mb-1 block text-sm font-medium text-[var(--brand-text)]">
                      Notes / Reason
                    </label>
                    <textarea
                      id="accountDescription"
                      name="description"
                      required
                      rows={3}
                      className="w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm"
                      placeholder="Example: Credit from overpayment, floor fee owed, refund credit, or manual account adjustment."
                    />
                  </div>

                  <button
                    type="submit"
                    className="rounded-2xl bg-[linear-gradient(135deg,#0d1536_0%,#111b45_50%,#5b145e_100%)] px-4 py-3 text-sm font-medium text-white hover:brightness-105"
                  >
                    Save Account Entry
                  </button>
                </form>
              ) : null}

              <div className="mt-5 border-t border-[var(--brand-border)] pt-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                    Ledger History
                  </h4>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                    {typedAccountLedger.length} entries
                  </span>
                </div>

                <div className="mt-3 space-y-3">
                  {typedAccountLedger.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-6 text-sm text-slate-500">
                      No client account ledger entries yet. Add credit or a charge when the client has money on account, owes a balance, or needs a truthful manual adjustment.
                    </div>
                  ) : (
                    accountLedgerPreview.map((entry) => (
                      <div
                        key={entry.id}
                        className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="font-medium text-[var(--brand-text)]">
                              {accountLedgerTypeLabel(entry.entry_type)}
                            </p>
                            <p className="mt-1 text-sm text-slate-500">
                              {fmtShortDate(entry.entry_date)}
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${accountDirectionBadgeClass(entry.direction)}`}>
                              {entry.direction}
                            </span>
                            <span className="font-semibold text-[var(--brand-text)]">
                              {fmtCurrency(Number(entry.amount ?? 0))}
                            </span>
                          </div>
                        </div>

                        {entry.description ? (
                          <p className="mt-2 text-sm text-slate-600">{entry.description}</p>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>

                {typedAccountLedger.length > accountLedgerPreview.length ? (
                  <p className="mt-3 text-xs text-slate-500">
                    Showing the most recent {accountLedgerPreview.length} ledger entries. The balance summary uses the full ledger history.
                  </p>
                ) : null}
              </div>
            </details>
          </SectionCard>
          ) : null}

          {activeTab === "notes" && typedClient.status === "lead" ? (
            <>
              <QuickActionPanel
                title="Quick Lead Follow-Up"
                description="Add a note, call, text, email, consultation, or follow-up reminder without leaving this page."
                defaultOpen
              >
                <LeadActivityForm clientId={typedClient.id} returnTo={returnTo} />
              </QuickActionPanel>

              <SectionCard
                title="Lead Activity Timeline"
                subtitle="Recent lead outreach, reminders, and completed follow-ups."
              >
                <div className="space-y-3">
                  {typedLeadActivities.length === 0 ? (
                    <p className="text-slate-500">No lead activity logged yet.</p>
                  ) : (
                    typedLeadActivities.map((activity) => (
                      <div
                        key={activity.id}
                        className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium text-[var(--brand-text)]">
                              {activityLabel(activity.activity_type)}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {fmtDateTime(activity.created_at)}
                            </p>
                          </div>

                          {activity.follow_up_due_at ? (
                            <span
                              className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                                activity.completed_at
                                  ? "bg-green-50 text-green-700"
                                  : "bg-amber-50 text-amber-700"
                              }`}
                            >
                              {activity.completed_at ? "Completed" : "Open"}
                            </span>
                          ) : null}
                        </div>

                        <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">
                          {activity.note}
                        </p>

                        {activity.follow_up_due_at ? (
                          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                            <p className="text-xs text-slate-500">
                              Follow-up due: {fmtDateTime(activity.follow_up_due_at)}
                            </p>

                            {!activity.completed_at ? (
                              <form action={completeLeadFollowUpAction}>
                                <input type="hidden" name="activityId" value={activity.id} />
                                <input type="hidden" name="clientId" value={typedClient.id} />
                                <input type="hidden" name="returnTo" value={returnTo} />
                                <button
                                  type="submit"
                                  className="text-xs font-medium underline"
                                >
                                  Mark Complete
                                </button>
                              </form>
                            ) : null}
                          </div>
                        ) : null}

                        <p className="mt-3 text-xs text-slate-500">
                          By: {getAuthorName(activity.profiles)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </SectionCard>
            </>
          ) : null}

          {activeTab === "schedule" && isIndependentInstructor ? (
            <SectionCard
              title="Floor Space Rentals"
              subtitle="Floor rentals are tracked separately from lesson package usage and standard attendance workflows."
              action={
                <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">
                  Portal + Admin Visibility
                </span>
              }
            >
              <div className="grid gap-5 xl:grid-cols-2">
                <div>
                  <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                    Upcoming Rentals
                  </h4>

                  <div className="mt-3 space-y-3">
                    {upcomingFloorRentals.length === 0 ? (
                      <p className="text-sm text-slate-500">No upcoming floor rentals.</p>
                    ) : (
                      upcomingFloorRentals.map((appointment) => (
                        <Link
                          key={appointment.id}
                          href={`/app/schedule/${appointment.id}`}
                          className="block rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4 hover:bg-white"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-medium text-[var(--brand-text)]">
                                  {appointment.title ||
                                    appointmentTypeLabel(appointment.appointment_type)}
                                </p>
                                <span className="inline-flex rounded-full bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700">
                                  Floor Rental
                                </span>
                              </div>

                              <p className="mt-1 text-sm text-slate-600">
                                {fmtDateTime(appointment.starts_at, studioTimeZone)}
                              </p>
                              <p className="mt-1 text-sm text-slate-500">
                                {getRoomName(appointment.rooms) === "No room"
                                  ? "No room required"
                                  : `Room: ${getRoomName(appointment.rooms)}`}
                              </p>
                            </div>

                            <span
                              className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(
                                appointment.status
                              )}`}
                            >
                              {appointment.status}
                            </span>
                          </div>
                        </Link>
                      ))
                    )}
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                    Recent Rental History
                  </h4>

                  <div className="mt-3 space-y-3">
                    {recentFloorRentals.length === 0 ? (
                      <p className="text-sm text-slate-500">No recent floor rentals.</p>
                    ) : (
                      recentFloorRentals.slice(0, 6).map((appointment) => (
                        <Link
                          key={appointment.id}
                          href={`/app/schedule/${appointment.id}`}
                          className="block rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4 hover:bg-white"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-medium text-[var(--brand-text)]">
                                  {appointment.title ||
                                    appointmentTypeLabel(appointment.appointment_type)}
                                </p>
                                <span className="inline-flex rounded-full bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700">
                                  Floor Rental
                                </span>
                              </div>

                              <p className="mt-1 text-sm text-slate-600">
                                {fmtDateTime(appointment.starts_at, studioTimeZone)}
                              </p>
                              <p className="mt-1 text-sm text-slate-500">
                                {getRoomName(appointment.rooms) === "No room"
                                  ? "No room required"
                                  : `Room: ${getRoomName(appointment.rooms)}`}
                              </p>
                            </div>

                            <span
                              className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(
                                appointment.status
                              )}`}
                            >
                              {appointment.status}
                            </span>
                          </div>
                        </Link>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </SectionCard>
          ) : null}

          {activeTab === "schedule" ? (
          <div className="grid gap-5 xl:grid-cols-2">
            <SectionCard
              title="Upcoming Appointments"
              action={
                <Link href="/app/schedule" className="text-sm underline">
                  Open schedule
                </Link>
              }
            >
              <div className="space-y-4">
                <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-[var(--brand-text)]">
                        {typedUpcoming.length} upcoming
                      </p>
                      {nextAppointment ? (
                        <p className="mt-1 text-sm text-slate-600">
                          Next: {fmtDateTime(nextAppointment.starts_at, studioTimeZone)} · {nextAppointment.title || appointmentTypeLabel(nextAppointment.appointment_type)}
                        </p>
                      ) : (
                        <p className="mt-1 text-sm text-slate-500">
                          No upcoming appointments.
                        </p>
                      )}
                    </div>

                    {nextAppointment ? (
                      <Link
                        href={`/app/schedule/${nextAppointment.id}`}
                        className="rounded-full border border-[var(--brand-border)] bg-white px-3 py-1.5 text-sm font-medium text-[var(--brand-text)] hover:bg-slate-50"
                      >
                        Open next
                      </Link>
                    ) : null}
                  </div>
                </div>

                {typedUpcoming.length > 0 ? (
                  <details className="group rounded-2xl border border-[var(--brand-border)] bg-white p-4">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-[var(--brand-text)]">
                      <span>View upcoming appointment list</span>
                      <span className="text-xs font-medium text-slate-500 group-open:hidden">
                        Show
                      </span>
                      <span className="hidden text-xs font-medium text-slate-500 group-open:inline">
                        Hide
                      </span>
                    </summary>

                    <div className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-100">
                      {upcomingPreviewAppointments.map((appointment) => (
                        <Link
                          key={appointment.id}
                          href={`/app/schedule/${appointment.id}`}
                          className="flex flex-col gap-2 p-3 hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-medium text-[var(--brand-text)]">
                                {appointment.title || appointmentTypeLabel(appointment.appointment_type)}
                              </p>
                              {isFloorRental(appointment.appointment_type) ? (
                                <span className="inline-flex rounded-full bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700">
                                  Floor Rental
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-1 text-sm text-slate-600">
                              {fmtDateTime(appointment.starts_at, studioTimeZone)}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {isFloorRental(appointment.appointment_type)
                                ? getRoomName(appointment.rooms) === "No room"
                                  ? "No room required • No package deduction"
                                  : `Room: ${getRoomName(appointment.rooms)} • No package deduction`
                                : `${getInstructorName(appointment.instructors)} • ${getRoomName(
                                    appointment.rooms
                                  )}`}
                            </p>
                          </div>
                          <span
                            className={`inline-flex w-fit rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(
                              appointment.status
                            )}`}
                          >
                            {appointment.status}
                          </span>
                        </Link>
                      ))}
                    </div>

                    {typedUpcoming.length > upcomingPreviewAppointments.length ? (
                      <p className="mt-3 text-xs text-slate-500">
                        Showing next {upcomingPreviewAppointments.length} of {typedUpcoming.length}. Use the schedule to view more.
                      </p>
                    ) : null}
                  </details>
                ) : null}
              </div>
            </SectionCard>

            <SectionCard
              title="Recent Appointments"
              action={
                <Link href="/app/schedule" className="text-sm underline">
                  View history
                </Link>
              }
            >
              <div className="space-y-4">
                <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-[var(--brand-text)]">
                        {typedRecent.length} recent
                      </p>
                      {lastAppointment ? (
                        <p className="mt-1 text-sm text-slate-600">
                          Last: {fmtDateTime(lastAppointment.starts_at, studioTimeZone)} · {lastAppointment.title || appointmentTypeLabel(lastAppointment.appointment_type)}
                        </p>
                      ) : (
                        <p className="mt-1 text-sm text-slate-500">
                          No recent appointments.
                        </p>
                      )}
                    </div>

                    {lastAppointment ? (
                      <Link
                        href={`/app/schedule/${lastAppointment.id}`}
                        className="rounded-full border border-[var(--brand-border)] bg-white px-3 py-1.5 text-sm font-medium text-[var(--brand-text)] hover:bg-slate-50"
                      >
                        Open last
                      </Link>
                    ) : null}
                  </div>
                </div>

                {typedRecent.length > 0 ? (
                  <details className="group rounded-2xl border border-[var(--brand-border)] bg-white p-4">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-[var(--brand-text)]">
                      <span>View recent appointment list</span>
                      <span className="text-xs font-medium text-slate-500 group-open:hidden">
                        Show
                      </span>
                      <span className="hidden text-xs font-medium text-slate-500 group-open:inline">
                        Hide
                      </span>
                    </summary>

                    <div className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-100">
                      {recentPreviewAppointments.map((appointment) => (
                        <Link
                          key={appointment.id}
                          href={`/app/schedule/${appointment.id}`}
                          className="flex flex-col gap-2 p-3 hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-medium text-[var(--brand-text)]">
                                {appointment.title || appointmentTypeLabel(appointment.appointment_type)}
                              </p>
                              {isFloorRental(appointment.appointment_type) ? (
                                <span className="inline-flex rounded-full bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700">
                                  Floor Rental
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-1 text-sm text-slate-600">
                              {fmtDateTime(appointment.starts_at, studioTimeZone)}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {isFloorRental(appointment.appointment_type)
                                ? getRoomName(appointment.rooms) === "No room"
                                  ? "No room required • No package deduction"
                                  : `Room: ${getRoomName(appointment.rooms)} • No package deduction`
                                : `${getInstructorName(appointment.instructors)} • ${getRoomName(
                                    appointment.rooms
                                  )}`}
                            </p>
                          </div>
                          <span
                            className={`inline-flex w-fit rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(
                              appointment.status
                            )}`}
                          >
                            {appointment.status}
                          </span>
                        </Link>
                      ))}
                    </div>

                    {typedRecent.length > recentPreviewAppointments.length ? (
                      <p className="mt-3 text-xs text-slate-500">
                        Showing latest {recentPreviewAppointments.length} of {typedRecent.length}. Use the schedule to view more.
                      </p>
                    ) : null}
                  </details>
                ) : null}
              </div>
            </SectionCard>
          </div>
          ) : null}

          {activeTab === "billing" ? (
          <div className="grid gap-5 xl:grid-cols-2">
            <SectionCard
              title="Payments"
              action={
                <Link href="/app/payments" className="text-sm underline">
                  View payments
                </Link>
              }
            >
              <div className="space-y-3">
                {typedPayments.length === 0 ? (
                  <p className="text-slate-500">No payments recorded.</p>
                ) : (
                  typedPayments.map((payment) => (
                    <div
                      key={payment.id}
                      className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="font-medium text-[var(--brand-text)]">
                          {fmtCurrency(Number(payment.amount ?? 0))}
                        </p>

                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(
                              payment.status
                            )}`}
                          >
                            {payment.status}
                          </span>

                          <span
                            className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${paymentSourceBadgeClass(
                              payment.source
                            )}`}
                          >
                            {paymentSourceLabel(payment.source)}
                          </span>

                          <span
                            className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${paymentTypeBadgeClass(
                              payment.payment_type
                            )}`}
                          >
                            {paymentTypeLabel(payment.payment_type)}
                          </span>
                        </div>
                      </div>

                      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        <div>
                          <p className="text-xs uppercase tracking-wide text-slate-400">
                            Method
                          </p>
                          <p className="mt-1 text-sm font-medium text-[var(--brand-text)]">
                            {paymentMethodLabel(payment.payment_method)}
                          </p>
                        </div>

                        <div>
                          <p className="text-xs uppercase tracking-wide text-slate-400">
                            Date
                          </p>
                          <p className="mt-1 text-sm font-medium text-[var(--brand-text)]">
                            {fmtDateTime(payment.created_at)}
                          </p>
                        </div>

                        <div>
                          <p className="text-xs uppercase tracking-wide text-slate-400">
                            Invoice
                          </p>
                          <p className="mt-1 break-all text-sm font-medium text-[var(--brand-text)]">
                            {payment.stripe_invoice_id ?? "—"}
                          </p>
                        </div>
                      </div>

                      {payment.notes ? (
                        <div className="mt-3 rounded-2xl border border-[var(--brand-border)] bg-white p-3">
                          <p className="text-sm text-slate-600">{payment.notes}</p>
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </SectionCard>

            <SectionCard
              title="Lesson & Package Ledger"
              action={
                <Link href="/app/packages/client-balances" className="text-sm underline">
                  View balances
                </Link>
              }
            >
              <div className="space-y-3">
                {typedLedger.length === 0 ? (
                  <p className="text-slate-500">No ledger entries recorded.</p>
                ) : (
                  typedLedger.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 md:p-4"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium text-[var(--brand-text)]">
                          {entry.transaction_type}
                        </p>
                        <p className="text-sm text-slate-500">
                          {fmtDateTime(entry.created_at)}
                        </p>
                      </div>

                      <div className="mt-2 flex flex-wrap gap-4 text-sm text-slate-600">
                        <span>
                          Delta: {entry.lessons_delta === null ? "—" : entry.lessons_delta}
                        </span>
                        <span>
                          Balance After:{" "}
                          {entry.balance_after === null ? "—" : entry.balance_after}
                        </span>
                      </div>

                      {entry.notes ? (
                        <p className="mt-2 text-sm text-slate-600">{entry.notes}</p>
                      ) : null}

                      {entry.appointment_id ? (
                        <Link
                          href={`/app/schedule/${entry.appointment_id}`}
                          className="mt-2 inline-block text-sm underline"
                        >
                          View Appointment
                        </Link>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </SectionCard>
          </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
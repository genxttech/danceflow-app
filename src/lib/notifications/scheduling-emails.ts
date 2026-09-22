/**
 * BR-3B1 pure builders for studio/client scheduling emails.
 *
 * Each builder returns `{ subject, bodyText, bodyHtml }`. The text part is the full plain-text letter; the HTML part
 * renders the greeting and intro through the shell's own fields and passes only the remaining paragraphs as the body,
 * so the HTML never repeats them. Studio identity always comes from `resolveStudioDisplayName` (public_name first).
 * Action URLs are built with `buildAppUrl`. These live outside the "use server" action files, which can only export
 * async functions.
 */
import {
  buildAppUrl,
  resolveStudioDisplayName,
  sanitizeEmailSubject,
} from "@/lib/email/brand";
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";

export type StudioEmailSource = {
  name?: string | null;
  public_name?: string | null;
  public_logo_url?: string | null;
  slug?: string | null;
};

export type BuiltEmail = {
  subject: string;
  bodyText: string;
  bodyHtml: string;
};

const REQUESTS_PATH = "/app/schedule/requests";
export const PORTAL_STAFF_REVIEW_PATH = "/app/schedule/requests?status=pending";
export const STAFF_SCHEDULE_PATH = "/app/schedule";

function identityOf(studio: StudioEmailSource) {
  return {
    name: resolveStudioDisplayName(studio),
    logoUrl: studio.public_logo_url ?? null,
  };
}

/** Joins lines with real newlines, keeping "" separators (only null/undefined/false entries are dropped). */
function letter(lines: Array<string | null | undefined | false>) {
  return lines
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function paragraphs(blocks: Array<string | null | undefined | false>) {
  return blocks
    .filter((block): block is string => typeof block === "string" && block.trim() !== "")
    .join("\n\n");
}

/** Public booking form: confirmation to the prospect. */
export function buildPublicBookingClientEmail(params: {
  studio: StudioEmailSource;
  customerName: string;
  requestedTime: string;
}): BuiltEmail {
  const identity = identityOf(params.studio);
  const studioName = identity.name;
  const firstName = params.customerName.split(" ")[0] || "there";
  const greeting = `Hi ${firstName},`;
  const intro = `${studioName} received your intro lesson request for ${params.requestedTime}.`;
  const followUp =
    "The studio will review the request and follow up with next steps. Your appointment is not confirmed until the studio approves it.";
  const subject = sanitizeEmailSubject(`${studioName} received your lesson request`);

  const bodyText = letter([greeting, "", intro, "", followUp, "", "Thanks,", studioName]);
  const bodyHtml = renderStudioBrandedEmail(identity, {
    previewText: subject,
    eyebrow: "Lesson Request",
    heading: "Request Received",
    greeting,
    intro,
    bodyText: paragraphs([followUp, `Thanks,\n${studioName}`]),
    detailRows: [{ label: "Requested time", value: params.requestedTime }],
  });

  return { subject, bodyText, bodyHtml };
}

/** Public booking form: internal alert to studio staff. */
export function buildPublicBookingStaffEmail(params: {
  studio: StudioEmailSource;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  requestedTime: string;
  danceInterests: string | null;
  notes: string | null;
}): BuiltEmail {
  const identity = identityOf(params.studio);
  const studioName = identity.name;
  const requestsUrl = buildAppUrl(REQUESTS_PATH);
  const subject = sanitizeEmailSubject(`New intro lesson request: ${params.customerName}`);

  const bodyText = letter([
    `New intro lesson request for ${studioName}`,
    "",
    `Client: ${params.customerName}`,
    `Email: ${params.customerEmail}`,
    params.customerPhone ? `Phone: ${params.customerPhone}` : null,
    `Requested time: ${params.requestedTime}`,
    params.danceInterests ? `Dance interests: ${params.danceInterests}` : null,
    params.notes ? `Notes: ${params.notes}` : null,
    "",
    `Review request: ${requestsUrl}`,
  ]);

  const bodyHtml = renderStudioBrandedEmail(identity, {
    previewText: `New intro lesson request from ${params.customerName}`,
    eyebrow: "New Booking Lead",
    heading: "New Intro Lesson Request",
    intro: `${params.customerName} submitted a public booking request.`,
    bodyText: "",
    detailRows: [
      { label: "Client", value: params.customerName },
      { label: "Email", value: params.customerEmail },
      ...(params.customerPhone ? [{ label: "Phone", value: params.customerPhone }] : []),
      { label: "Requested time", value: params.requestedTime },
      ...(params.danceInterests
        ? [{ label: "Dance interests", value: params.danceInterests }]
        : []),
      ...(params.notes ? [{ label: "Notes", value: params.notes }] : []),
    ],
    actionLabel: "Review Request",
    actionUrl: requestsUrl,
    footerNote: `Internal notification for ${studioName} staff.`,
  });

  return { subject, bodyText, bodyHtml };
}

/** Portal schedule request: confirmation to the portal client. */
export function buildPortalBookingClientEmail(params: {
  studio: StudioEmailSource;
  clientFirstName: string | null;
  lessonType: string;
  requestedTime: string;
}): BuiltEmail {
  const identity = identityOf(params.studio);
  const studioName = identity.name;
  const greeting = `Hi ${params.clientFirstName?.trim() || "there"},`;
  const intro = `${studioName} received your request for ${params.lessonType} on ${params.requestedTime}.`;
  const followUp =
    "The studio will review your request and confirm whether the time is available.";
  const subject = sanitizeEmailSubject(`${studioName} received your schedule request`);

  const bodyText = letter([greeting, "", intro, "", followUp, "", "Thanks,", studioName]);
  const bodyHtml = renderStudioBrandedEmail(identity, {
    previewText: subject,
    eyebrow: "Schedule Request",
    heading: "Request Received",
    greeting,
    intro,
    bodyText: paragraphs([followUp, `Thanks,\n${studioName}`]),
    detailRows: [
      { label: "Lesson type", value: params.lessonType },
      { label: "Requested time", value: params.requestedTime },
    ],
  });

  return { subject, bodyText, bodyHtml };
}

/** Portal schedule request: internal alert to studio staff, with an absolute review link. */
export function buildPortalBookingStaffEmail(params: {
  studio: StudioEmailSource;
  clientName: string;
  lessonType: string;
  requestedTime: string;
}): BuiltEmail {
  const identity = identityOf(params.studio);
  const studioName = identity.name;
  const reviewUrl = buildAppUrl(PORTAL_STAFF_REVIEW_PATH);
  const subject = sanitizeEmailSubject(`New portal schedule request: ${params.clientName}`);
  const intro = "A portal client requested a lesson time.";

  const bodyText = letter([
    intro,
    "",
    `Client: ${params.clientName}`,
    `Lesson type: ${params.lessonType}`,
    `Requested time: ${params.requestedTime}`,
    "",
    "Review the request in DanceFlow:",
    reviewUrl,
  ]);

  const bodyHtml = renderStudioBrandedEmail(identity, {
    previewText: subject,
    eyebrow: "Schedule Request",
    heading: "New Portal Schedule Request",
    intro,
    bodyText: "",
    detailRows: [
      { label: "Client", value: params.clientName },
      { label: "Lesson type", value: params.lessonType },
      { label: "Requested time", value: params.requestedTime },
    ],
    actionLabel: "Review request",
    actionUrl: reviewUrl,
    footerNote: `Internal notification for ${studioName} staff.`,
  });

  return { subject, bodyText, bodyHtml };
}

/** Schedule request approved or declined: email to the client. */
export function buildScheduleDecisionClientEmail(params: {
  studio: StudioEmailSource;
  status: "approved" | "declined";
  clientFirstName: string | null;
  requestedTime: string;
  staffNote: string | null;
}): BuiltEmail {
  const identity = identityOf(params.studio);
  const studioName = identity.name;
  const approved = params.status === "approved";
  const note = params.staffNote?.trim() || null;
  const greeting = `Hi ${params.clientFirstName?.trim() || "there"},`;
  const intro = approved
    ? `${studioName} approved your lesson request for ${params.requestedTime}.`
    : `${studioName} reviewed your lesson request for ${params.requestedTime}, but it was not approved for that time.`;
  const detail = approved
    ? letter(["Your appointment has been added to the studio schedule.", note ? `Studio note: ${note}` : null])
    : note
      ? `Studio note: ${note}`
      : "Please contact the studio if you would like to request another time.";
  const subject = sanitizeEmailSubject(
    approved
      ? `${studioName} approved your lesson request`
      : `${studioName} update about your lesson request`,
  );
  const portalUrl = params.studio.slug
    ? buildAppUrl(`/portal/${encodeURIComponent(params.studio.slug)}`)
    : null;

  const bodyText = letter([
    greeting,
    "",
    intro,
    "",
    detail,
    portalUrl ? "" : null,
    portalUrl ? `Open Client Portal: ${portalUrl}` : null,
    "",
    "Thanks,",
    studioName,
  ]);

  const bodyHtml = renderStudioBrandedEmail(identity, {
    previewText: subject,
    eyebrow: approved ? "Lesson Request Approved" : "Lesson Request Update",
    heading: approved ? "Your lesson request is approved" : "Your lesson request was reviewed",
    greeting,
    intro,
    bodyText: paragraphs([detail, `Thanks,\n${studioName}`]),
    detailRows: [{ label: "Requested time", value: params.requestedTime }],
    actionLabel: portalUrl ? "Open Client Portal" : undefined,
    actionUrl: portalUrl ?? undefined,
  });

  return { subject, bodyText, bodyHtml };
}

/** Approved request: assignment email to the instructor, pointing to the studio schedule (not the client portal). */
export function buildInstructorAssignmentEmail(params: {
  studio: StudioEmailSource;
  instructorFirstName: string | null;
  clientName: string;
  appointmentTitle: string;
  appointmentTime: string;
  staffNote: string | null;
}): BuiltEmail {
  const identity = identityOf(params.studio);
  const studioName = identity.name;
  const note = params.staffNote?.trim() || null;
  const greeting = `Hi ${params.instructorFirstName?.trim() || "there"},`;
  const intro = `${studioName} approved ${params.appointmentTitle} with ${params.clientName} for ${params.appointmentTime}.`;
  const detail = letter(["The appointment is now on the studio schedule.", note ? `Studio note: ${note}` : null]);
  const scheduleUrl = buildAppUrl(STAFF_SCHEDULE_PATH);
  const subject = sanitizeEmailSubject(`New appointment assigned: ${params.clientName}`);

  const bodyText = letter([
    greeting,
    "",
    intro,
    "",
    detail,
    "",
    `Open Schedule: ${scheduleUrl}`,
    "",
    "Thanks,",
    studioName,
  ]);

  const bodyHtml = renderStudioBrandedEmail(identity, {
    previewText: subject,
    eyebrow: "Schedule Assignment",
    heading: "A new appointment was assigned to you",
    greeting,
    intro,
    bodyText: paragraphs([detail, `Thanks,\n${studioName}`]),
    detailRows: [
      { label: "Client", value: params.clientName },
      { label: "Appointment", value: params.appointmentTitle },
      { label: "Time", value: params.appointmentTime },
    ],
    actionLabel: "Open Schedule",
    actionUrl: scheduleUrl,
  });

  return { subject, bodyText, bodyHtml };
}

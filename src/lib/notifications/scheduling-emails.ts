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

/**
 * GC-S1C-4: ONE consolidated email per attendee when "This and following classes" cancels several
 * of their booked classes. `classTimes` are already formatted in the studio time zone, in order.
 */
export function buildGroupClassSeriesCancellationEmail(params: {
  studio: StudioEmailSource;
  firstName: string | null;
  classTitle: string;
  classTimes: string[];
}): BuiltEmail {
  const identity = identityOf(params.studio);
  const studioName = identity.name;
  const greeting = `Hi ${params.firstName?.trim() || "there"},`;
  const count = params.classTimes.length;
  const title = params.classTitle.trim() || "your class";
  const intro =
    count === 1
      ? `${studioName} cancelled ${title} on ${params.classTimes[0]}.`
      : `${studioName} cancelled ${count} upcoming sessions of ${title} that you were booked into.`;
  const list = count > 1 ? params.classTimes.map((time) => `- ${time}`).join("\n") : null;
  const detail = "You do not need to do anything. Contact the studio if you have any questions.";
  const subject = sanitizeEmailSubject(`${studioName}: ${title} cancelled`);
  const portalUrl = params.studio.slug
    ? buildAppUrl(`/portal/${encodeURIComponent(params.studio.slug)}`)
    : null;

  const bodyText = letter([
    greeting,
    "",
    intro,
    list ? "" : null,
    list,
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
    eyebrow: "Class Cancelled",
    heading: count === 1 ? "Your class was cancelled" : "Your classes were cancelled",
    greeting,
    intro,
    bodyText: paragraphs([list, detail, `Thanks,\n${studioName}`]),
    detailRows: [{ label: "Class", value: title }],
    actionLabel: portalUrl ? "Open Client Portal" : undefined,
    actionUrl: portalUrl ?? undefined,
  });

  return { subject, bodyText, bodyHtml };
}

// ---------------------------------------------------------------------------------------------------------------------
// GC-S1E-2: group-class change / enrollment / removal notices (one email per dancer per event)
// ---------------------------------------------------------------------------------------------------------------------

export type GroupClassChangeLine = { label: string; from: string | null; to: string | null };

function portalUrlOf(studio: StudioEmailSource) {
  return studio.slug ? buildAppUrl(`/portal/${encodeURIComponent(studio.slug)}`) : null;
}

function describeChange(line: GroupClassChangeLine) {
  const from = line.from?.trim() || "not set";
  const to = line.to?.trim() || "not set";
  return `${line.label}: ${from} -> ${to}`;
}

/**
 * ONE email per dancer when a class (or the upcoming classes of a series) changes date/time, instructor or room/location.
 * `changes` carries only the fields that really changed, already formatted for the studio time zone. `classCount` > 1 means a
 * consolidated "This and following classes" notice; `startsLabel` is then the first changed class.
 */
export function buildGroupClassChangedEmail(params: {
  studio: StudioEmailSource;
  firstName: string | null;
  classTitle: string;
  changes: GroupClassChangeLine[];
  classCount: number;
  startsLabel: string | null;
}): BuiltEmail {
  const identity = identityOf(params.studio);
  const studioName = identity.name;
  const greeting = `Hi ${params.firstName?.trim() || "there"},`;
  const title = params.classTitle.trim() || "your class";
  const multiple = params.classCount > 1;
  const intro = multiple
    ? `${studioName} updated ${params.classCount} upcoming sessions of ${title} that you are enrolled in${params.startsLabel ? `, starting ${params.startsLabel}` : ""}.`
    : `${studioName} updated ${title}${params.startsLabel ? ` (${params.startsLabel})` : ""}.`;
  const list = params.changes.map((line) => `- ${describeChange(line)}`).join("\n");
  const detail = "Your enrollment has not changed. Contact the studio if the new arrangement does not work for you.";
  const subject = sanitizeEmailSubject(`${studioName}: ${title} ${multiple ? "schedule" : "details"} changed`);
  const portalUrl = portalUrlOf(params.studio);

  const bodyText = letter([
    greeting,
    "",
    intro,
    "",
    "What changed:",
    list,
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
    eyebrow: "Class Update",
    heading: multiple ? "Your classes were updated" : "Your class was updated",
    greeting,
    intro,
    bodyText: paragraphs([detail, `Thanks,\n${studioName}`]),
    detailRows: [
      { label: "Class", value: title },
      ...params.changes.map((line) => ({ label: line.label, value: `${line.from?.trim() || "not set"} -> ${line.to?.trim() || "not set"}` })),
    ],
    actionLabel: portalUrl ? "Open Client Portal" : undefined,
    actionUrl: portalUrl ?? undefined,
  });

  return { subject, bodyText, bodyHtml };
}

/** One enrollment confirmation per dancer: a single class, or a consolidated "This and following classes" enrollment. */
export function buildGroupClassEnrollmentEmail(params: {
  studio: StudioEmailSource;
  firstName: string | null;
  classTitle: string;
  firstClass: string;
  classCount: number;
  instructorName: string | null;
  locationName: string | null;
  /** The dancer enrolled themselves (client portal): the confirmation speaks to their own action, not the studio's. */
  selfEnrolled?: boolean;
}): BuiltEmail {
  const identity = identityOf(params.studio);
  const studioName = identity.name;
  const greeting = `Hi ${params.firstName?.trim() || "there"},`;
  const title = params.classTitle.trim() || "your class";
  const multiple = params.classCount > 1;
  const intro = params.selfEnrolled
    ? multiple
      ? `You're enrolled in ${params.classCount} sessions of ${title}, starting ${params.firstClass}.`
      : `You're enrolled in ${title} on ${params.firstClass}.`
    : multiple
      ? `${studioName} enrolled you in ${params.classCount} sessions of ${title}, starting ${params.firstClass}.`
      : `${studioName} enrolled you in ${title} on ${params.firstClass}.`;
  const rows: Array<{ label: string; value: string }> = [
    { label: "Class", value: title },
    { label: multiple ? "Starting" : "When", value: params.firstClass },
    ...(multiple ? [{ label: "Sessions", value: String(params.classCount) }] : []),
    ...(params.instructorName ? [{ label: "Instructor", value: params.instructorName }] : []),
    ...(params.locationName ? [{ label: "Location", value: params.locationName }] : []),
  ];
  const detail = "You do not need to do anything. Contact the studio if you have any questions.";
  const subject = sanitizeEmailSubject(`${studioName}: you are enrolled in ${title}`);
  const portalUrl = portalUrlOf(params.studio);

  const bodyText = letter([
    greeting,
    "",
    intro,
    "",
    ...rows.map((row) => `${row.label}: ${row.value}`),
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
    eyebrow: "Class Enrollment",
    heading: "You are enrolled",
    greeting,
    intro,
    bodyText: paragraphs([detail, `Thanks,\n${studioName}`]),
    detailRows: rows,
    actionLabel: portalUrl ? "Open Client Portal" : undefined,
    actionUrl: portalUrl ?? undefined,
  });

  return { subject, bodyText, bodyHtml };
}

/**
 * One removal notice per dancer. `keptCount` classes (attendance already recorded) were NOT removed and the copy says so; no
 * credit or refund language is used because removal does not restore anything.
 */
export function buildGroupClassRemovalEmail(params: {
  studio: StudioEmailSource;
  firstName: string | null;
  classTitle: string;
  firstClass: string;
  classCount: number;
  keptCount: number;
}): BuiltEmail {
  const identity = identityOf(params.studio);
  const studioName = identity.name;
  const greeting = `Hi ${params.firstName?.trim() || "there"},`;
  const title = params.classTitle.trim() || "your class";
  const multiple = params.classCount > 1;
  const intro = multiple
    ? `${studioName} removed you from ${params.classCount} upcoming sessions of ${title}, starting ${params.firstClass}.`
    : `${studioName} removed you from ${title} on ${params.firstClass}.`;
  const kept =
    params.keptCount > 0
      ? `${params.keptCount === 1 ? "One class" : `${params.keptCount} classes`} where attendance was already recorded ${params.keptCount === 1 ? "was" : "were"} not changed.`
      : null;
  const detail = "Contact the studio if you have any questions about your enrollment.";
  const subject = sanitizeEmailSubject(`${studioName}: removed from ${title}`);
  const portalUrl = portalUrlOf(params.studio);

  const bodyText = letter([
    greeting,
    "",
    intro,
    kept ? "" : null,
    kept,
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
    eyebrow: "Class Enrollment",
    heading: multiple ? "You were removed from classes" : "You were removed from a class",
    greeting,
    intro,
    bodyText: paragraphs([kept, detail, `Thanks,\n${studioName}`]),
    detailRows: [
      { label: "Class", value: title },
      { label: multiple ? "Starting" : "When", value: params.firstClass },
      ...(multiple ? [{ label: "Sessions removed", value: String(params.classCount) }] : []),
    ],
    actionLabel: portalUrl ? "Open Client Portal" : undefined,
    actionUrl: portalUrl ?? undefined,
  });

  return { subject, bodyText, bodyHtml };
}

/**
 * GC-S1F: internal operational notice to studio staff that a dancer enrolled themselves in a class through the client portal
 * (no staff involved). The funding line describes the real funding source (package credit or membership) and this email never
 * claims a payment: self-enrollment is funded by an existing package or membership only.
 */
export function buildGroupClassExternalEnrollmentStaffEmail(params: {
  studio: StudioEmailSource;
  dancerName: string;
  classTitle: string;
  classWhen: string;
  instructorName: string | null;
  locationName: string | null;
  fundingLabel: string;
  classPath: string;
}): BuiltEmail {
  const identity = identityOf(params.studio);
  const studioName = identity.name;
  const title = params.classTitle.trim() || "Group class";
  const dancer = params.dancerName.trim() || "A dancer";
  const classUrl = buildAppUrl(params.classPath);
  const subject = sanitizeEmailSubject(`New class enrollment: ${dancer} joined ${title}`);
  const intro = `${dancer} enrolled in ${title} from the client portal.`;
  const rows: Array<{ label: string; value: string }> = [
    { label: "Dancer", value: dancer },
    { label: "Class", value: title },
    { label: "When", value: params.classWhen },
    { label: "Status", value: "Enrolled" },
    { label: "Funding", value: params.fundingLabel },
    ...(params.instructorName ? [{ label: "Instructor", value: params.instructorName }] : []),
    ...(params.locationName ? [{ label: "Location", value: params.locationName }] : []),
  ];

  const bodyText = letter([
    intro,
    "",
    ...rows.map((row) => `${row.label}: ${row.value}`),
    "",
    "View the class roster in DanceFlow:",
    classUrl,
  ]);

  const bodyHtml = renderStudioBrandedEmail(identity, {
    previewText: subject,
    eyebrow: "Class Enrollment",
    heading: "New Class Enrollment",
    intro,
    bodyText: "",
    detailRows: rows,
    actionLabel: "View class roster",
    actionUrl: classUrl,
    footerNote: `Internal notification for ${studioName} staff.`,
  });

  return { subject, bodyText, bodyHtml };
}

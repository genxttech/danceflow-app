/**
 * GC-S1E-2: automatic notices for canonical group classes -- a material class change (date/time, instructor, room/location),
 * an enrollment and a removal, for a single class and for the consolidated "This and following classes" operations.
 *
 * Rules every function here follows:
 *  - It runs only AFTER the underlying mutation has committed, never throws, and a delivery problem is logged and cannot undo
 *    the mutation. The operation succeeds even when nobody can be reached.
 *  - Recipients are derived server-side from authoritative rows (booked attendees, the clients' own studio, the account links);
 *    nothing is taken from the browser. Every query is scoped to the studio.
 *  - Branded HTML email through outbound_deliveries (deduplicated by a deterministic key) plus one short push per portal
 *    account. No SMS.
 *  - One notice per dancer per event: several classes, fields or classes-per-dancer are summarized, never sent one by one.
 *  - Notes, capacity and every other non-schedule field never notify.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import { sendGroupClassNoticePush } from "@/lib/notifications/schedulePush";
import {
  buildGroupClassChangedEmail,
  buildGroupClassEnrollmentEmail,
  buildGroupClassExternalEnrollmentStaffEmail,
  buildGroupClassRemovalEmail,
  type GroupClassChangeLine,
  type StudioEmailSource,
} from "@/lib/notifications/scheduling-emails";
import { getStudioRegistrationNotificationEmails } from "@/lib/notifications/studioStaffRecipients";
import { normalizedStartKey } from "@/lib/notifications/groupClassReminders";
import { dancersNotifiedLine } from "@/lib/schedule/groupClassEditNotice";

const DEFAULT_TIME_ZONE = "America/New_York";

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

export type ClassMaterialSnapshot = {
  startsAt: string | null;
  endsAt: string | null;
  instructorId: string | null;
  roomId: string | null;
  locationName: string | null;
};

export type ClassMaterialDiff = { time: boolean; instructor: boolean; room: boolean; location: boolean; any: boolean };

function cleanText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

/**
 * Which material fields really changed. The time compares canonical instants (start and end), so a different spelling of the
 * same instant is not a change; blank and missing location are the same. Notes, capacity and everything else are not part of
 * the snapshot at all, so they can never notify.
 */
export function diffClassMaterial(before: ClassMaterialSnapshot, after: ClassMaterialSnapshot): ClassMaterialDiff {
  const time =
    normalizedStartKey(before.startsAt) !== normalizedStartKey(after.startsAt) ||
    normalizedStartKey(before.endsAt) !== normalizedStartKey(after.endsAt);
  const instructor = (before.instructorId ?? null) !== (after.instructorId ?? null);
  const room = (before.roomId ?? null) !== (after.roomId ?? null);
  const location = cleanText(before.locationName) !== cleanText(after.locationName);
  return { time, instructor, room, location, any: time || instructor || room || location };
}

/** Deterministic idempotency key for one notice event and one address. */
export function groupClassNoticeDedupeKey(kind: string, eventId: string, email: string) {
  return `${kind}:${eventId}:${email.trim().toLowerCase()}`;
}

/** Identity of one push notice event; the studio is part of it so identical event ids can never collide across studios. */
export function groupClassPushNoticeKey(kind: string, studioId: string, subjectId: string, eventId: string) {
  return `${kind}:${studioId}:${subjectId}:${eventId}`;
}

export function formatClassStart(value: string | null | undefined, timeZone: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function formatClassTimeOnly(value: string | null | undefined, timeZone: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

/** "Tue, Nov 10, 6:00 PM - 7:00 PM". */
export function formatClassRange(startsAt: string | null | undefined, endsAt: string | null | undefined, timeZone: string) {
  const start = formatClassStart(startsAt, timeZone);
  const end = formatClassTimeOnly(endsAt, timeZone);
  return start && end ? `${start} - ${end}` : start;
}

/** The change lines for the fields that changed, with names resolved by the caller. */
export function buildChangeLines(params: {
  diff: ClassMaterialDiff;
  before: ClassMaterialSnapshot;
  after: ClassMaterialSnapshot;
  timeZone: string;
  names: { instructor: (id: string | null) => string | null; room: (id: string | null) => string | null };
}): GroupClassChangeLine[] {
  const { diff, before, after, timeZone, names } = params;
  const lines: GroupClassChangeLine[] = [];
  if (diff.time) {
    lines.push({ label: "Date and time", from: formatClassRange(before.startsAt, before.endsAt, timeZone), to: formatClassRange(after.startsAt, after.endsAt, timeZone) });
  }
  if (diff.instructor) {
    lines.push({ label: "Instructor", from: names.instructor(before.instructorId), to: names.instructor(after.instructorId) });
  }
  if (diff.room) {
    lines.push({ label: "Room", from: names.room(before.roomId), to: names.room(after.roomId) });
  }
  if (diff.location) {
    lines.push({ label: "Location", from: cleanText(before.locationName) || null, to: cleanText(after.locationName) || null });
  }
  return lines;
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Short push copy; the email carries the detail. */
export function changePushCopy(params: { title: string; multiple: boolean; classCount: number; startsLabel: string }) {
  const title = cleanText(params.title) || "Your class";
  return params.multiple
    ? { title: "Your classes changed", body: `${plural(params.classCount, "upcoming session", "upcoming sessions")} of ${title} changed, starting ${params.startsLabel}. Check your email for details.` }
    : { title: "Your class changed", body: `${title}${params.startsLabel ? ` (${params.startsLabel})` : ""} was updated. Check your email for details.` };
}

export function enrollmentPushCopy(params: { title: string; classCount: number; startsLabel: string }) {
  const title = cleanText(params.title) || "your class";
  return {
    title: "You are enrolled",
    body: params.classCount > 1 ? `You are enrolled in ${params.classCount} sessions of ${title}, starting ${params.startsLabel}.` : `You are enrolled in ${title} on ${params.startsLabel}.`,
  };
}

export function removalPushCopy(params: { title: string; classCount: number; startsLabel: string }) {
  const title = cleanText(params.title) || "your class";
  return {
    title: "Your enrollment was removed",
    body: params.classCount > 1 ? `You were removed from ${params.classCount} sessions of ${title}, starting ${params.startsLabel}.` : `You were removed from ${title} on ${params.startsLabel}.`,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Orchestration (server-side reads only; every query scoped to the studio)
// ---------------------------------------------------------------------------------------------------------------------

type Admin = SupabaseClient;

type StudioContext = { studio: StudioEmailSource; timeZone: string };

async function loadStudioContext(admin: Admin, studioId: string): Promise<StudioContext> {
  const [{ data: studio }, { data: settings }] = await Promise.all([
    admin.from("studios").select("name, public_name, public_logo_url, slug").eq("id", studioId).maybeSingle(),
    admin.from("studio_settings").select("timezone").eq("studio_id", studioId).maybeSingle(),
  ]);
  return {
    studio: (studio as StudioEmailSource | null) ?? {},
    timeZone: (settings as { timezone?: string | null } | null)?.timezone || DEFAULT_TIME_ZONE,
  };
}

type ClientRecord = { id: string; first_name: string | null; email: string | null };

async function loadClients(admin: Admin, studioId: string, clientIds: string[]): Promise<Map<string, ClientRecord>> {
  const ids = Array.from(new Set(clientIds.filter(Boolean)));
  const map = new Map<string, ClientRecord>();
  if (!ids.length) return map;
  const { data } = await admin.from("clients").select("id, first_name, email").eq("studio_id", studioId).in("id", ids);
  for (const row of (data ?? []) as ClientRecord[]) map.set(row.id, row);
  return map;
}

async function loadNames(admin: Admin, studioId: string, instructorIds: string[], roomIds: string[]) {
  const instructors = new Map<string, string>();
  const rooms = new Map<string, string>();
  const iIds = Array.from(new Set(instructorIds.filter(Boolean)));
  const rIds = Array.from(new Set(roomIds.filter(Boolean)));
  if (iIds.length) {
    const { data } = await admin.from("instructors").select("id, first_name, last_name").eq("studio_id", studioId).in("id", iIds);
    for (const row of (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
      instructors.set(row.id, [cleanText(row.first_name), cleanText(row.last_name)].filter(Boolean).join(" "));
    }
  }
  if (rIds.length) {
    const { data } = await admin.from("rooms").select("id, name").eq("studio_id", studioId).in("id", rIds);
    for (const row of (data ?? []) as Array<{ id: string; name: string | null }>) rooms.set(row.id, cleanText(row.name));
  }
  return {
    instructor: (id: string | null) => (id ? instructors.get(id) || null : null),
    room: (id: string | null) => (id ? rooms.get(id) || null : null),
  };
}

export type NoticeOutcome = { emailsQueued: number; pushedAccounts: number };
const NOTHING: NoticeOutcome = { emailsQueued: 0, pushedAccounts: 0 };

/** One email per distinct address (several dancers behind one address are merged), never throws. */
async function queueOneEmailPerAddress(params: {
  studioId: string;
  templateKey: string;
  relatedTable: string;
  relatedId: string;
  dedupeKind: string;
  eventId: string;
  recipients: Array<{ email: string }>;
  build: (email: string) => { subject: string; bodyText: string; bodyHtml: string } | null;
}): Promise<{ queued: number; duplicates: number }> {
  let queued = 0;
  let duplicates = 0;
  const seen = new Set<string>();
  for (const recipient of params.recipients) {
    const email = recipient.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    try {
      const built = params.build(email);
      if (!built) continue;
      const outcome = await queueOutboundDelivery({
        studioId: params.studioId,
        channel: "email",
        templateKey: params.templateKey,
        recipientEmail: email,
        subject: built.subject,
        bodyText: built.bodyText,
        bodyHtml: built.bodyHtml,
        relatedTable: params.relatedTable,
        relatedId: params.relatedId,
        dedupeKey: groupClassNoticeDedupeKey(params.dedupeKind, params.eventId, email),
      });
      if (outcome.queued) queued += 1;
      else if ("reason" in outcome && outcome.reason === "duplicate") duplicates += 1;
    } catch (error) {
      console.error(`Group-class notice (${params.templateKey}) could not be queued for one address:`, error);
    }
  }
  return { queued, duplicates };
}

/**
 * A single class changed. `eventId` identifies THIS edit (the saved row's updated_at), so a retried notification for the same
 * edit cannot send twice while a later, separate edit still notifies. Notifies the currently booked attendees, once each.
 */
export async function notifyGroupClassChanged(params: {
  studioId: string;
  appointmentId: string;
  before: ClassMaterialSnapshot;
  after: ClassMaterialSnapshot;
  eventId: string;
}): Promise<NoticeOutcome> {
  const diff = diffClassMaterial(params.before, params.after);
  if (!diff.any) return NOTHING;

  try {
    const admin = createAdminClient();
    const { studioId, appointmentId } = params;

    const [{ data: appointment }, { data: attendees }, ctx] = await Promise.all([
      admin.from("appointments").select("title, status").eq("id", appointmentId).eq("studio_id", studioId).maybeSingle(),
      admin.from("appointment_attendees").select("client_id").eq("studio_id", studioId).eq("appointment_id", appointmentId).eq("status", "booked"),
      loadStudioContext(admin, studioId),
    ]);
    if (!appointment || (appointment as { status?: string }).status === "cancelled") return NOTHING;

    const clientIds = Array.from(new Set(((attendees ?? []) as Array<{ client_id: string }>).map((row) => row.client_id)));
    if (!clientIds.length) return NOTHING;

    const [clients, names] = await Promise.all([
      loadClients(admin, studioId, clientIds),
      loadNames(admin, studioId, [params.before.instructorId ?? "", params.after.instructorId ?? ""], [params.before.roomId ?? "", params.after.roomId ?? ""]),
    ]);

    const title = cleanText((appointment as { title?: string | null }).title) || "Group class";
    const changes = buildChangeLines({ diff, before: params.before, after: params.after, timeZone: ctx.timeZone, names });
    const startsLabel = formatClassStart(params.after.startsAt, ctx.timeZone);

    const recipients: Array<{ email: string; firstName: string | null }> = [];
    for (const clientId of clientIds) {
      const client = clients.get(clientId);
      if (client?.email?.trim()) recipients.push({ email: client.email, firstName: client.first_name });
    }
    const firstNameByEmail = new Map(recipients.map((r) => [r.email.trim().toLowerCase(), r.firstName]));

    const { queued: emailsQueued } = await queueOneEmailPerAddress({
      studioId,
      templateKey: "group_class_changed",
      relatedTable: "appointments",
      relatedId: appointmentId,
      dedupeKind: `group_class_changed:${appointmentId}`,
      eventId: params.eventId,
      recipients,
      build: (email) =>
        buildGroupClassChangedEmail({ studio: ctx.studio, firstName: firstNameByEmail.get(email) ?? null, classTitle: title, changes, classCount: 1, startsLabel }),
    });

    const copy = changePushCopy({ title, multiple: false, classCount: 1, startsLabel });
    let pushedAccounts = 0;
    try {
      // only dancers whose client row belongs to this studio are pushed (the roster row alone is not trusted)
      pushedAccounts = await sendGroupClassNoticePush({ supabase: admin, studioId, appointmentId, clientIds: clientIds.filter((id) => clients.has(id)), kind: "changed", noticeKey: groupClassPushNoticeKey("group_class_changed", studioId, appointmentId, params.eventId), ...copy });
    } catch (error) {
      console.error("Class changed, but the change push failed:", error);
    }
    return { emailsQueued, pushedAccounts };
  } catch (error) {
    console.error("Class changed, but change notices failed:", error);
    return NOTHING;
  }
}

export type ClassSnapshotMap = Map<string, ClassMaterialSnapshot>;

/**
 * "This and following classes" edit. `before`/`after` are server-side snapshots of the affected occurrences taken around the
 * successful apply; only occurrences that really changed a material field count. Each affected dancer gets ONE consolidated
 * notice (email per address, one push per account) regardless of how many of their classes changed. `eventId` is the edit's
 * request id, so a retried notification cannot send twice.
 */
export async function notifyGroupClassSeriesChanged(params: {
  studioId: string;
  eventId: string;
  seriesId: string;
  before: ClassSnapshotMap;
  after: ClassSnapshotMap;
}): Promise<NoticeOutcome> {
  const changed: Array<{ id: string; diff: ClassMaterialDiff; before: ClassMaterialSnapshot; after: ClassMaterialSnapshot }> = [];
  for (const [id, after] of params.after) {
    const before = params.before.get(id);
    if (!before) continue;
    const diff = diffClassMaterial(before, after);
    if (diff.any) changed.push({ id, diff, before, after });
  }
  if (!changed.length) return NOTHING;
  changed.sort((a, b) => (normalizedStartKey(a.after.startsAt) ?? "").localeCompare(normalizedStartKey(b.after.startsAt) ?? "", undefined, { numeric: true }));

  try {
    const admin = createAdminClient();
    const { studioId } = params;
    const changedIds = changed.map((c) => c.id);

    const [{ data: attendees }, { data: appointments }, ctx] = await Promise.all([
      admin.from("appointment_attendees").select("client_id, appointment_id").eq("studio_id", studioId).eq("status", "booked").in("appointment_id", changedIds),
      admin.from("appointments").select("id, title, status").eq("studio_id", studioId).in("id", changedIds),
      loadStudioContext(admin, studioId),
    ]);

    const live = new Set(((appointments ?? []) as Array<{ id: string; status: string }>).filter((a) => a.status !== "cancelled").map((a) => a.id));
    const classesByClient = new Map<string, Set<string>>();
    for (const row of (attendees ?? []) as Array<{ client_id: string; appointment_id: string }>) {
      if (!live.has(row.appointment_id)) continue;
      const set = classesByClient.get(row.client_id) ?? new Set<string>();
      set.add(row.appointment_id);
      classesByClient.set(row.client_id, set);
    }
    if (!classesByClient.size) return NOTHING;

    const instructorIds = changed.flatMap((c) => [c.before.instructorId ?? "", c.after.instructorId ?? ""]);
    const roomIds = changed.flatMap((c) => [c.before.roomId ?? "", c.after.roomId ?? ""]);
    const [clients, names] = await Promise.all([loadClients(admin, studioId, Array.from(classesByClient.keys())), loadNames(admin, studioId, instructorIds, roomIds)]);

    const title = cleanText(((appointments ?? []) as Array<{ title: string | null }>)[0]?.title) || "Group class";
    const byId = new Map(changed.map((c) => [c.id, c]));

    // per address: the union of its dancers' changed classes
    const perEmail = new Map<string, { firstName: string | null; classIds: Set<string> }>();
    for (const [clientId, classIds] of classesByClient) {
      const email = clients.get(clientId)?.email?.trim().toLowerCase();
      if (!email) continue;
      const entry = perEmail.get(email) ?? { firstName: clients.get(clientId)?.first_name ?? null, classIds: new Set<string>() };
      classIds.forEach((id) => entry.classIds.add(id));
      perEmail.set(email, entry);
    }

    const { queued: emailsQueued } = await queueOneEmailPerAddress({
      studioId,
      templateKey: "group_class_series_changed",
      relatedTable: "group_class_series",
      relatedId: params.seriesId,
      dedupeKind: `group_class_series_changed:${params.seriesId}`,
      eventId: params.eventId,
      recipients: Array.from(perEmail.keys()).map((email) => ({ email })),
      build: (email) => {
        const entry = perEmail.get(email);
        if (!entry) return null;
        const mine = Array.from(entry.classIds).map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => Boolean(c));
        if (!mine.length) return null;
        // each changed field is described from the dancer's first class where that field changed
        const lines: GroupClassChangeLine[] = [];
        for (const field of ["time", "instructor", "room", "location"] as const) {
          const first = mine.find((c) => c.diff[field]);
          if (!first) continue;
          lines.push(...buildChangeLines({ diff: { time: false, instructor: false, room: false, location: false, [field]: true, any: true }, before: first.before, after: first.after, timeZone: ctx.timeZone, names }));
        }
        return buildGroupClassChangedEmail({
          studio: ctx.studio,
          firstName: entry.firstName,
          classTitle: title,
          changes: lines,
          classCount: mine.length,
          startsLabel: formatClassStart(mine[0].after.startsAt, ctx.timeZone),
        });
      },
    });

    // one push per account with identical, short copy (starts at the earliest changed class overall)
    const copy = changePushCopy({ title, multiple: true, classCount: changed.length, startsLabel: formatClassStart(changed[0].after.startsAt, ctx.timeZone) });
    let pushedAccounts = 0;
    try {
      pushedAccounts = await sendGroupClassNoticePush({ supabase: admin, studioId, appointmentId: changed[0].id, clientIds: Array.from(classesByClient.keys()).filter((id) => clients.has(id)), kind: "changed", noticeKey: groupClassPushNoticeKey("group_class_series_changed", studioId, params.seriesId, params.eventId), ...copy });
    } catch (error) {
      console.error("Series changed, but the change push failed:", error);
    }
    return { emailsQueued, pushedAccounts };
  } catch (error) {
    console.error("Series changed, but change notices failed:", error);
    return NOTHING;
  }
}

async function loadEnrollmentClasses(admin: Admin, studioId: string, appointmentIds: string[]) {
  const ids = Array.from(new Set(appointmentIds.filter(Boolean)));
  if (!ids.length) return [];
  const { data } = await admin
    .from("appointments")
    .select("id, title, starts_at, instructor_id, room_id, location_name")
    .eq("studio_id", studioId)
    .in("id", ids);
  return ((data ?? []) as Array<{ id: string; title: string | null; starts_at: string | null; instructor_id: string | null; room_id: string | null; location_name: string | null }>)
    .filter((row) => row.starts_at)
    .sort((a, b) => String(normalizedStartKey(a.starts_at)).localeCompare(String(normalizedStartKey(b.starts_at)), undefined, { numeric: true }));
}

/**
 * The dancer was enrolled in `appointmentIds` (one class, or the classes a series enrollment actually created). One email and
 * one push. `eventId` identifies the event (the new attendee id for a single class; one id per apply for a series).
 */
export async function notifyGroupClassEnrolled(params: {
  studioId: string;
  clientId: string;
  appointmentIds: string[];
  eventId: string;
  series: boolean;
  /** GC-S1F: the dancer enrolled themselves through the client portal (changes only the wording of the email). */
  selfEnrolled?: boolean;
}): Promise<NoticeOutcome> {
  if (!params.appointmentIds.length) return NOTHING;
  try {
    const admin = createAdminClient();
    const { studioId } = params;
    const [classes, clients, ctx] = await Promise.all([
      loadEnrollmentClasses(admin, studioId, params.appointmentIds),
      loadClients(admin, studioId, [params.clientId]),
      loadStudioContext(admin, studioId),
    ]);
    const client = clients.get(params.clientId);
    if (!client || !classes.length) return NOTHING;

    const first = classes[0];
    const names = await loadNames(admin, studioId, [first.instructor_id ?? ""], [first.room_id ?? ""]);
    const title = cleanText(first.title) || "Group class";
    const startsLabel = formatClassStart(first.starts_at, ctx.timeZone);
    const locationName = cleanText(first.location_name) || names.room(first.room_id);

    const emailResult = client.email?.trim()
      ? await queueOneEmailPerAddress({
          studioId,
          templateKey: params.series ? "group_class_series_enrolled" : "group_class_enrolled",
          relatedTable: "appointments",
          relatedId: first.id,
          dedupeKind: params.series ? "group_class_series_enrolled" : "group_class_enrolled",
          eventId: params.eventId,
          recipients: [{ email: client.email }],
          build: () =>
            buildGroupClassEnrollmentEmail({
              studio: ctx.studio,
              firstName: client.first_name,
              classTitle: title,
              firstClass: startsLabel,
              classCount: classes.length,
              instructorName: names.instructor(first.instructor_id),
              locationName: locationName || null,
              selfEnrolled: params.selfEnrolled === true,
            }),
        })
      : { queued: 0, duplicates: 0 };
    const emailsQueued = emailResult.queued;

    const copy = enrollmentPushCopy({ title, classCount: classes.length, startsLabel });
    let pushedAccounts = 0;
    try {
      pushedAccounts = await sendGroupClassNoticePush({
        supabase: admin,
        studioId,
        appointmentId: first.id,
        clientIds: [params.clientId],
        kind: "enrolled",
        noticeKey: groupClassPushNoticeKey(params.series ? "group_class_series_enrolled" : "group_class_enrolled", studioId, params.clientId, params.eventId),
        ...copy,
      });
    } catch (error) {
      console.error("Enrolled, but the enrollment push failed:", error);
    }
    return { emailsQueued, pushedAccounts };
  } catch (error) {
    console.error("Enrolled, but the enrollment notice failed:", error);
    return NOTHING;
  }
}

/**
 * The dancer was removed from `appointmentIds` (the classes the removal actually cancelled). `keptCount` classes with recorded
 * attendance were left as they were and are mentioned truthfully. No credit or refund language.
 */
export async function notifyGroupClassRemoved(params: {
  studioId: string;
  clientId: string;
  appointmentIds: string[];
  keptCount: number;
  eventId: string;
  series: boolean;
}): Promise<NoticeOutcome> {
  if (!params.appointmentIds.length) return NOTHING;
  try {
    const admin = createAdminClient();
    const { studioId } = params;
    const [classes, clients, ctx] = await Promise.all([
      loadEnrollmentClasses(admin, studioId, params.appointmentIds),
      loadClients(admin, studioId, [params.clientId]),
      loadStudioContext(admin, studioId),
    ]);
    const client = clients.get(params.clientId);
    if (!client || !classes.length) return NOTHING;

    const first = classes[0];
    const title = cleanText(first.title) || "Group class";
    const startsLabel = formatClassStart(first.starts_at, ctx.timeZone);

    const emailResult = client.email?.trim()
      ? await queueOneEmailPerAddress({
          studioId,
          templateKey: params.series ? "group_class_series_removed" : "group_class_removed",
          relatedTable: "appointments",
          relatedId: first.id,
          dedupeKind: params.series ? "group_class_series_removed" : "group_class_removed",
          eventId: params.eventId,
          recipients: [{ email: client.email }],
          build: () =>
            buildGroupClassRemovalEmail({
              studio: ctx.studio,
              firstName: client.first_name,
              classTitle: title,
              firstClass: startsLabel,
              classCount: classes.length,
              keptCount: Math.max(0, params.keptCount),
            }),
        })
      : { queued: 0, duplicates: 0 };
    const emailsQueued = emailResult.queued;

    const copy = removalPushCopy({ title, classCount: classes.length, startsLabel });
    let pushedAccounts = 0;
    try {
      pushedAccounts = await sendGroupClassNoticePush({
        supabase: admin,
        studioId,
        appointmentId: first.id,
        clientIds: [params.clientId],
        kind: "removed",
        noticeKey: groupClassPushNoticeKey(params.series ? "group_class_series_removed" : "group_class_removed", studioId, params.clientId, params.eventId),
        ...copy,
      });
    } catch (error) {
      console.error("Removed, but the removal push failed:", error);
    }
    return { emailsQueued, pushedAccounts };
  } catch (error) {
    console.error("Removed, but the removal notice failed:", error);
    return NOTHING;
  }
}

/**
 * Single-class removal: the notice is derived from the cancelled attendee row itself (its studio, class and client), so nothing
 * from the browser decides who is told. A row that is not cancelled, or is not in this studio, sends nothing. The row id is the
 * event identity, so repeating the action on an already removed dancer cannot notify again.
 */
export async function notifyGroupClassRemovedByAttendee(params: { studioId: string; attendeeId: string }): Promise<NoticeOutcome> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("appointment_attendees")
      .select("id, client_id, appointment_id, status")
      .eq("id", params.attendeeId)
      .eq("studio_id", params.studioId)
      .maybeSingle();
    const row = data as { id: string; client_id: string; appointment_id: string; status: string } | null;
    if (!row || row.status !== "cancelled") return NOTHING;
    return await notifyGroupClassRemoved({
      studioId: params.studioId,
      clientId: row.client_id,
      appointmentIds: [row.appointment_id],
      keptCount: 0,
      eventId: row.id,
      series: false,
    });
  } catch (error) {
    console.error("Removed, but the removal notice failed:", error);
    return NOTHING;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Series edit support: server-side snapshots and the review-step notification line
// ---------------------------------------------------------------------------------------------------------------------

/** Series change-set keys that are material to a dancer (date/time, instructor, room/location). Title and capacity are not. */
const MATERIAL_SERIES_CHANGE_KEYS = ["instructor_id", "room_id", "location_name", "local_start_time", "duration_minutes"];

export function seriesChangesAreMaterial(changes: Record<string, unknown> | null | undefined): boolean {
  return !!changes && MATERIAL_SERIES_CHANGE_KEYS.some((key) => key in changes);
}

const SNAPSHOT_COLUMNS = "id, starts_at, ends_at, instructor_id, room_id, location_name";

type SnapshotRow = {
  id: string;
  starts_at: string | null;
  ends_at: string | null;
  instructor_id: string | null;
  room_id: string | null;
  location_name: string | null;
};

function toSnapshot(row: SnapshotRow): ClassMaterialSnapshot {
  return { startsAt: row.starts_at, endsAt: row.ends_at, instructorId: row.instructor_id, roomId: row.room_id, locationName: row.location_name };
}

/**
 * The anchor class and every later, not-cancelled occurrence across the successor lineage, read server-side with the caller's
 * own (studio-scoped) session. Used to describe what a "This and following classes" edit changed without touching the released
 * edit RPC. Returns null when any read fails, so the caller skips the notice rather than guessing.
 */
export async function snapshotSeriesFollowing(
  supabase: SupabaseClient,
  studioId: string,
  anchorId: string,
): Promise<{ seriesId: string; classes: ClassSnapshotMap } | null> {
  try {
    const { data: anchor, error: anchorError } = await supabase
      .from("appointments")
      .select("group_class_series_id, series_occurrence_index")
      .eq("id", anchorId)
      .eq("studio_id", studioId)
      .maybeSingle<{ group_class_series_id: string | null; series_occurrence_index: number | null }>();
    if (anchorError || !anchor?.group_class_series_id || typeof anchor.series_occurrence_index !== "number") return null;

    const seriesIds = [anchor.group_class_series_id];
    let frontier = [anchor.group_class_series_id];
    for (let depth = 0; depth < 60 && frontier.length; depth += 1) {
      const { data, error } = await supabase.from("group_class_series").select("id").eq("studio_id", studioId).in("split_from_series_id", frontier);
      if (error) return null;
      frontier = ((data ?? []) as Array<{ id: string }>).map((row) => row.id).filter((id) => !seriesIds.includes(id));
      seriesIds.push(...frontier);
    }

    const { data: rows, error } = await supabase
      .from("appointments")
      .select(SNAPSHOT_COLUMNS)
      .eq("studio_id", studioId)
      .eq("appointment_type", "group_class")
      .in("group_class_series_id", seriesIds)
      .gte("series_occurrence_index", anchor.series_occurrence_index)
      .neq("status", "cancelled");
    if (error) return null;

    const classes: ClassSnapshotMap = new Map();
    for (const row of (rows ?? []) as SnapshotRow[]) classes.set(row.id, toSnapshot(row));
    return { seriesId: anchor.group_class_series_id, classes };
  } catch {
    return null;
  }
}

/** The same fields for known occurrence ids (the "after" half of a before/after pair). */
export async function snapshotClassesByIds(supabase: SupabaseClient, studioId: string, ids: string[]): Promise<ClassSnapshotMap | null> {
  if (!ids.length) return new Map();
  try {
    const { data, error } = await supabase.from("appointments").select(SNAPSHOT_COLUMNS).eq("studio_id", studioId).in("id", ids);
    if (error) return null;
    const classes: ClassSnapshotMap = new Map();
    for (const row of (data ?? []) as SnapshotRow[]) classes.set(row.id, toSnapshot(row));
    return classes;
  } catch {
    return null;
  }
}

/** Unique enrolled (booked) dancers across the classes -- a dancer in several classes counts once. Null when unreadable. */
export async function countEnrolledDancers(supabase: SupabaseClient, studioId: string, appointmentIds: string[]): Promise<number | null> {
  if (!appointmentIds.length) return 0;
  try {
    const { data, error } = await supabase
      .from("appointment_attendees")
      .select("client_id")
      .eq("studio_id", studioId)
      .eq("status", "booked")
      .in("appointment_id", appointmentIds);
    if (error) return null;
    return new Set(((data ?? []) as Array<{ client_id: string }>).map((row) => row.client_id)).size;
  } catch {
    return null;
  }
}


/**
 * The extra review line for "This and following classes": only when the change set touches date/time, instructor or room/
 * location and enrolled dancers exist in the classes the edit covers (not-cancelled classes from the selected one onward).
 */
export async function seriesEditNoticeLine(
  supabase: SupabaseClient,
  studioId: string,
  anchorId: string,
  changes: Record<string, unknown>,
): Promise<string | null> {
  if (!seriesChangesAreMaterial(changes)) return null;
  const snapshot = await snapshotSeriesFollowing(supabase, studioId, anchorId);
  if (!snapshot) return null;
  const count = await countEnrolledDancers(supabase, studioId, Array.from(snapshot.classes.keys()));
  return count === null ? null : dancersNotifiedLine(count);
}

/** The funding line of the studio notice; only package credit and membership exist for self-enrollment, never a payment claim. */
export function externalEnrollmentFundingLabel(billingType: string | null | undefined) {
  if (billingType === "package_credit") return "Package credit";
  if (billingType === "membership") return "Membership";
  return "Recorded funding source";
}

/**
 * GC-S1F: a dancer enrolled themselves through the client portal (no staff involved), so tell the studio. Runs only AFTER the
 * enrollment RPC committed and returned the new attendee id; that id is the event identity, so a retry or replay (which the RPC
 * refuses as "already enrolled" and never reaches here) cannot send twice. Recipients are the studio's active owners, admins and front-desk users
 * (getStudioRegistrationNotificationEmails), looked up for this studio only. Branded HTML + text, no SMS. Never
 * throws: the enrollment stands even if nobody can be reached.
 */
export async function notifyStudioOfExternalGroupClassEnrollment(params: { studioId: string; attendeeId: string }): Promise<NoticeOutcome> {
  try {
    const admin = createAdminClient();
    const { studioId, attendeeId } = params;
    const { data: attendee } = await admin
      .from("appointment_attendees")
      .select("id, appointment_id, client_id, status, billing_type")
      .eq("id", attendeeId)
      .eq("studio_id", studioId)
      .maybeSingle();
    const row = attendee as { id: string; appointment_id: string; client_id: string; status: string; billing_type: string | null } | null;
    // only a committed, booked enrollment is announced
    if (!row || row.status !== "booked") return NOTHING;

    const [{ data: appointment }, { data: client }, ctx, recipients] = await Promise.all([
      admin.from("appointments").select("id, title, starts_at, instructor_id, room_id, location_name, appointment_type").eq("id", row.appointment_id).eq("studio_id", studioId).maybeSingle(),
      admin.from("clients").select("id, first_name, last_name").eq("id", row.client_id).eq("studio_id", studioId).maybeSingle(),
      loadStudioContext(admin, studioId),
      getStudioRegistrationNotificationEmails(admin, studioId),
    ]);
    const cls = appointment as { id: string; title: string | null; starts_at: string | null; instructor_id: string | null; room_id: string | null; location_name: string | null; appointment_type: string } | null;
    if (!cls || cls.appointment_type !== "group_class" || !recipients.length) return NOTHING;

    const names = await loadNames(admin, studioId, [cls.instructor_id ?? ""], [cls.room_id ?? ""]);
    const c = client as { first_name: string | null; last_name: string | null } | null;
    const dancerName = [cleanText(c?.first_name), cleanText(c?.last_name)].filter(Boolean).join(" ");
    const locationName = cleanText(cls.location_name) || names.room(cls.room_id);

    const result = await queueOneEmailPerAddress({
      studioId,
      templateKey: "group_class_external_enrollment_staff",
      relatedTable: "appointment_attendees",
      relatedId: attendeeId,
      dedupeKind: "group_class_external_enrollment_staff",
      eventId: attendeeId,
      recipients: recipients.map((email) => ({ email })),
      build: () =>
        buildGroupClassExternalEnrollmentStaffEmail({
          studio: ctx.studio,
          dancerName,
          classTitle: cleanText(cls.title) || "Group class",
          classWhen: formatClassStart(cls.starts_at, ctx.timeZone),
          instructorName: names.instructor(cls.instructor_id),
          locationName: locationName || null,
          fundingLabel: externalEnrollmentFundingLabel(row.billing_type),
          classPath: `/app/schedule/${cls.id}`,
        }),
    });
    return { emailsQueued: result.queued, pushedAccounts: 0 };
  } catch (error) {
    console.error("Enrolled, but the studio enrollment notice failed:", error);
    return NOTHING;
  }
}

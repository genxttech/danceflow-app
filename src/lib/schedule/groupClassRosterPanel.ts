/**
 * GC-S1D-1: pure rules and the read model for the class-detail roster panel (ONE group-class occurrence).
 *
 * The authoritative enrollment rules (duplicate prevention, capacity, cancelled-class refusal, funding eligibility,
 * studio / client ownership, authority) live in the database RPCs `enroll_class_attendee` and `cancel_class_attendee`
 * and their triggers. This module only shapes what staff see (capacity wording, funding / attendance labels, which rows
 * offer a Remove control) and maps outcomes to fixed owner-facing copy; database text never reaches the UI.
 * Enrollment, attendance and funding/payment are kept as three separate concepts: this panel lists and manages
 * ENROLLMENT, shows attendance state read-only, and links out to the attendance workflow.
 */

type SupabaseLike = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export type RosterCapacityState = "unlimited" | "open" | "full" | "over";

export type RosterCapacitySummary = {
  headline: string;
  detail: string;
  state: RosterCapacityState;
  seatsLeft: number | null;
};

export function rosterCapacitySummary(booked: number, capacity: number | null): RosterCapacitySummary {
  if (capacity === null || capacity === undefined) {
    return { headline: `Roster ${booked}`, detail: "No capacity limit", state: "unlimited", seatsLeft: null };
  }
  const headline = `Roster ${booked} / ${capacity}`;
  if (booked > capacity) {
    const over = booked - capacity;
    return { headline, detail: `Over capacity by ${over}`, state: "over", seatsLeft: 0 };
  }
  if (booked === capacity) {
    return { headline, detail: "Class is full", state: "full", seatsLeft: 0 };
  }
  const left = capacity - booked;
  return { headline, detail: `${left} ${left === 1 ? "seat" : "seats"} left`, state: "open", seatsLeft: left };
}

/** Concise, plain-language funding source for one enrollment (billing detail only; never a payment action). */
export function rosterFundingLabel(input: {
  billingType: string | null;
  paymentStatus: string | null;
  packageName: string | null;
  membershipName: string | null;
}): string | null {
  const { billingType, paymentStatus, packageName, membershipName } = input;
  if (billingType === "package_credit") return packageName ? `Package credit · ${packageName}` : "Package credit";
  if (billingType === "membership") return membershipName ? `Membership · ${membershipName}` : "Membership";
  if (billingType === "pay_as_you_go") return paymentStatus === "paid" ? "Pay as you go · Paid" : "Pay as you go · Unpaid";
  if (billingType === "free_comped") return "Comped";
  return null;
}

export type RosterAttendanceStatus = "registered" | "checked_in" | "attended" | "no_show" | "cancelled";

const ATTENDANCE_LABELS: Record<string, string> = {
  registered: "Registered",
  checked_in: "Checked in",
  attended: "Attended",
  no_show: "No-show",
  cancelled: "Cancelled",
};

export function rosterAttendanceLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  return ATTENDANCE_LABELS[status] ?? null;
}

/** attended / no_show are the recorded terminal outcomes (the same states the S1C-2 guards protect). */
export function isTerminalAttendance(status: string | null | undefined): boolean {
  return status === "attended" || status === "no_show";
}

export type RosterEntry = {
  attendeeId: string;
  clientId: string;
  name: string;
  enrollment: "enrolled" | "removed";
  attendanceStatus: string | null;
  attendanceLabel: string | null;
  fundingLabel: string | null;
  hasTerminalAttendance: boolean;
  /** A Remove control is offered only for an enrolled dancer without recorded attendance. */
  canRemove: boolean;
};

export type RosterPanelData = {
  entries: RosterEntry[];
  removed: RosterEntry[];
  bookedCount: number;
  capacity: RosterCapacitySummary;
};

type AttendeeRow = {
  id: string;
  client_id: string;
  status: string;
  billing_type?: string | null;
  payment_status?: string | null;
  clients?: { first_name: string | null; last_name: string | null } | { first_name: string | null; last_name: string | null }[] | null;
  client_packages?: { name_snapshot: string | null } | { name_snapshot: string | null }[] | null;
  client_memberships?: { name_snapshot: string | null } | { name_snapshot: string | null }[] | null;
};

type AttendanceRow = { client_id: string; status: string };

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function displayName(first: string | null | undefined, last: string | null | undefined) {
  return `${first ?? ""} ${last ?? ""}`.trim() || "Unnamed dancer";
}

/**
 * Pure builder. `includeFunding` is true only for broad staff (the assigned instructor never receives billing detail,
 * matching the existing instructor roster minimization). `canManage` is whether the viewer may use Remove at all.
 */
export function buildRosterPanel(params: {
  attendees: AttendeeRow[];
  attendance: AttendanceRow[];
  capacity: number | null;
  includeFunding: boolean;
  canManage: boolean;
}): RosterPanelData {
  const attendanceByClient = new Map<string, string>();
  for (const row of params.attendance) attendanceByClient.set(row.client_id, row.status);

  const toEntry = (row: AttendeeRow): RosterEntry => {
    const client = one(row.clients);
    const status = attendanceByClient.get(row.client_id) ?? null;
    const terminal = isTerminalAttendance(status);
    const enrolled = row.status === "booked";
    return {
      attendeeId: row.id,
      clientId: row.client_id,
      name: displayName(client?.first_name, client?.last_name),
      enrollment: enrolled ? "enrolled" : "removed",
      attendanceStatus: status,
      attendanceLabel: rosterAttendanceLabel(status),
      fundingLabel: params.includeFunding
        ? rosterFundingLabel({
            billingType: row.billing_type ?? null,
            paymentStatus: row.payment_status ?? null,
            packageName: one(row.client_packages)?.name_snapshot ?? null,
            membershipName: one(row.client_memberships)?.name_snapshot ?? null,
          })
        : null,
      hasTerminalAttendance: terminal,
      canRemove: params.canManage && enrolled && !terminal,
    };
  };

  const byName = (a: RosterEntry, b: RosterEntry) => a.name.localeCompare(b.name);
  const entries = params.attendees.filter((r) => r.status === "booked").map(toEntry).sort(byName);
  const removed = params.attendees.filter((r) => r.status !== "booked").map(toEntry).sort(byName);

  return {
    entries,
    removed,
    bookedCount: entries.length,
    capacity: rosterCapacitySummary(entries.length, params.capacity),
  };
}

/** Server read for the panel. Billing detail is selected only when `includeFunding` (broad staff). */
export async function loadRosterPanel(params: {
  supabase: SupabaseLike;
  studioId: string;
  appointmentId: string;
  capacity: number | null;
  includeFunding: boolean;
  canManage: boolean;
}): Promise<RosterPanelData> {
  const attendeeSelect = params.includeFunding
    ? "id, client_id, status, billing_type, payment_status, clients(first_name, last_name), client_packages(name_snapshot), client_memberships(name_snapshot)"
    : "id, client_id, status, clients(first_name, last_name)";

  const [{ data: attendees, error: attendeeError }, { data: attendance, error: attendanceError }] = await Promise.all([
    params.supabase
      .from("appointment_attendees")
      .select(attendeeSelect)
      .eq("studio_id", params.studioId)
      .eq("appointment_id", params.appointmentId),
    params.supabase
      .from("attendance_records")
      .select("client_id, status")
      .eq("studio_id", params.studioId)
      .eq("appointment_id", params.appointmentId),
  ]);

  if (attendeeError) throw new Error(`Failed to load the class roster: ${attendeeError.message}`);
  if (attendanceError) throw new Error(`Failed to load class attendance: ${attendanceError.message}`);

  return buildRosterPanel({
    attendees: (attendees ?? []) as AttendeeRow[],
    attendance: (attendance ?? []) as AttendanceRow[],
    capacity: params.capacity,
    includeFunding: params.includeFunding,
    canManage: params.canManage,
  });
}

// ---------------------------------------------------------------------------
// Banner copy (fixed; never database text)
// ---------------------------------------------------------------------------

const ROSTER_BANNERS: Record<string, { kind: "success" | "error"; message: string }> = {
  student_enrolled: { kind: "success", message: "Dancer added to the class." },
  student_enrolled_membership: { kind: "success", message: "Dancer added to the class and billed to their membership." },
  attendee_cancelled: { kind: "success", message: "Dancer removed from the class." },
  already_enrolled: { kind: "error", message: "That dancer is already enrolled in this class." },
  class_full: { kind: "error", message: "This class is full. Raise Maximum students in Edit class to add more dancers." },
  class_cancelled: { kind: "error", message: "This class has been cancelled and can't take new students." },
  membership_requires_selection: {
    kind: "error",
    message: "Select a specific membership before billing this enrollment to Membership, or choose a different funding type.",
  },
  no_eligible_entitlement: {
    kind: "error",
    message: "That membership does not include a group-class benefit. Choose a different funding source or bill manually.",
  },
  entitlement_exhausted: {
    kind: "error",
    message: "That membership has no allowance remaining for a group class this billing period. Choose a different funding source or bill manually.",
  },
  membership_not_active: {
    kind: "error",
    message: "That membership is not active for this dancer, or has expired. Choose a different funding source or bill manually.",
  },
  ambiguous_funding_source: {
    kind: "error",
    message: "This dancer has more than one eligible funding source and none was selected. Ask an owner, admin or front desk to complete the enrollment.",
  },
  enrollment_not_authorized: { kind: "error", message: "You do not have permission to enroll dancers in this class." },
  enrollment_failed: { kind: "error", message: "Could not add the dancer. Check the funding selection and try again." },
  missing_enrollment_target: { kind: "error", message: "Choose a dancer before adding them to the class." },
  attendee_attendance_recorded: {
    kind: "error",
    message: "Attendance is already recorded for this dancer. Correct the attendance record before removing them from the class.",
  },
  attendee_not_authorized: { kind: "error", message: "You do not have permission to manage this class's roster." },
  attendee_cancel_failed: { kind: "error", message: "Could not remove the dancer. Please try again." },
  missing_attendee: { kind: "error", message: "Could not find that enrollment. Reload the page and try again." },
};

/** Banner for a roster outcome code (success or error), kind-matched, or null. */
export function rosterBanner(search: {
  success?: string | null;
  error?: string | null;
}): { kind: "success" | "error"; message: string } | null {
  const code = search.success ?? search.error ?? "";
  const banner = ROSTER_BANNERS[code];
  if (!banner) return null;
  if (search.success && banner.kind !== "success") return null;
  if (!search.success && search.error && banner.kind !== "error") return null;
  return banner;
}

const ENROLLMENT_ERROR_CODES = new Set([
  "already_enrolled",
  "class_full",
  "class_cancelled",
  "membership_requires_selection",
  "no_eligible_entitlement",
  "entitlement_exhausted",
  "membership_not_active",
  "ambiguous_funding_source",
  "enrollment_not_authorized",
  "enrollment_failed",
  "missing_enrollment_target",
]);

/** True when the error code is an add-dancer refusal: the Add dancer panel reopens so the owner can correct and retry. */
export function isRosterEnrollmentError(code: string | null | undefined): boolean {
  return !!code && ENROLLMENT_ERROR_CODES.has(code);
}

/** Maps a raw enroll_class_attendee failure message to a stable code (shared with the Enroll Student page). */
export function classifyRosterEnrollError(message: string): string {
  if (message.includes("requires a specific membership to be selected")) return "membership_requires_selection";
  if (message.includes("has no applicable group-class benefit")) return "no_eligible_entitlement";
  if (message.includes("No allowance remaining")) return "entitlement_exhausted";
  if (message.includes("does not belong to this client, or is not active")) return "membership_not_active";
  if (message.includes("needs a billing decision")) return "ambiguous_funding_source";
  if (message.includes("GCSC3_CLASS_CANCELLED")) return "class_cancelled";
  if (message.includes("already enrolled")) return "already_enrolled";
  if (message.includes("no available seats")) return "class_full";
  if (message.includes("Not authorized to enroll")) return "enrollment_not_authorized";
  return "enrollment_failed";
}

/** The only in-context return path an enrollment failure may use: this exact class's detail page. */
export function safeRosterErrorReturn(value: string | null | undefined, appointmentId: string): string | null {
  if (!value) return null;
  return value === `/app/schedule/${appointmentId}` && /^[0-9a-f-]{36}$/i.test(appointmentId) ? value : null;
}

/** A class accepts new dancers only while it is upcoming-or-in-progress and not cancelled / marked final. */
export function rosterAcceptsNewDancers(input: { status: string; endsAtIso: string; nowMs: number }): boolean {
  if (["cancelled", "attended", "no_show"].includes(input.status)) return false;
  const ends = new Date(input.endsAtIso).getTime();
  return Number.isFinite(ends) && ends > input.nowMs;
}

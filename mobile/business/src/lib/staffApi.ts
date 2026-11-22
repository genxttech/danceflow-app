import { toPulseCards, type PulseCards } from "@/lib/pulseCards";

/*
  Client for the /api/staff/* contract (docs/mobile/Staff_API_Contract.md).

  - Every request carries the Supabase access token as a bearer. There is no cookie path.
  - A 401 refreshes the session once and retries; a second 401 is final.
  - Every refusal becomes a StaffApiError with the server's stable `code`. Screens branch on
    `staffErrorKind`, never on the display text.
  - Responses are kept in memory only (they carry client names and are `no-store`).
*/

export type StaffRole =
  | "studio_owner"
  | "studio_admin"
  | "front_desk"
  | "instructor"
  | "independent_instructor"
  | "organizer_owner"
  | "organizer_admin"
  | "organizer_staff";

/** Every key is optional on purpose: the contract says a missing key means false. */
export type StaffCapabilities = Partial<Record<string, boolean>>;

export type StaffWorkspace = {
  studioId: string;
  name: string;
  publicName: string | null;
  slug: string | null;
  role: string;
  accessAllowed: boolean;
  subscriptionStatus: string | null;
  capabilities: StaffCapabilities;
  /** Slice 2: the studio's IANA zone. Optional so a server without slice 2 still parses. */
  timeZone?: string | null;
};

export type StaffMe = {
  user: { id: string; email: string | null; fullName: string | null };
  workspaces: StaffWorkspace[];
};

export type PersonName = { id: string; firstName: string | null; lastName: string | null };

export type TodayAppointment = {
  id: string;
  title: string | null;
  appointmentType: string;
  status: string;
  startsAt: string;
  endsAt: string;
  room: { id: string; name: string } | null;
  locationName: string | null;
  client: PersonName | null;
  partner: PersonName | null;
};

/** One row of the studio-wide day: a Today row plus who teaches it (null for a floor rental or an unassigned slot). */
export type StudioAppointment = TodayAppointment & { instructor: PersonName | null };

export type StaffStudioDay = {
  studioId: string;
  date: string;
  timeZone: string;
  /** True when the day has more than 500 appointments and only the first 500 are here. */
  truncated: boolean;
  appointments: StudioAppointment[];
};

export type StaffToday = {
  studioId: string;
  date: string;
  timeZone: string;
  instructorId: string | null;
  appointments: TodayAppointment[];
};

export type StaffPulse = {
  studioId: string;
  timeZone: string;
  date: string;
  asOf: string;
  /** "studio" for owner, admin and front desk; "own" for an instructor (their own teaching day). */
  scope: "studio" | "own";
  instructorId: string | null;
  today: { total: number; upcoming: number; cancelled: number; truncated: boolean };
  next: { id: string; appointmentType: string; title: string | null; status: string; startsAt: string; endsAt: string } | null;
  /** null for an instructor, who has no studio-wide client view. */
  newClientsLast7Days: number | null;
  /** Only when asked for (GET /pulse?include=cards) and the server serves them; absent otherwise. */
  cards?: PulseCards | null;
};

export type AppointmentDetail = TodayAppointment & {
  studioId: string;
  /** Slice 2: the studio's IANA zone. Optional so a server without slice 2 still parses. */
  timeZone?: string | null;
  accessScope: "own-instructor" | "broad";
  notes: string | null;
  instructor: PersonName | null;
  roster?: {
    bookedCount: number;
    capacity: number | null;
    attendees: { clientId: string; name: string | null; attendanceStatus: string | null }[];
  } | null;
  recap?: {
    summary: string | null;
    homework: string | null;
    nextFocus: string | null;
    visibleToClient: boolean;
    updatedAt: string | null;
  } | null;
};

export type StaffApiErrorCode =
  | "unauthenticated"
  | "account_inactive"
  | "platform_admin_unsupported"
  | "invalid_request"
  | "not_a_member"
  | "workspace_paused"
  | "role_not_permitted"
  | "not_found"
  | "service_unavailable"
  /** 409: the record is not in a state that allows this write (e.g. a cancelled class, or outside the marking window). */
  | "not_markable"
  /** 429: the server's per-device or per-account limit; `Retry-After` says when to try again. The request was refused before any work, so nothing was applied. */
  | "rate_limited"
  /** 403: the server's write kill switch for this capability is off. Reads still work. */
  | "writes_disabled"
  /** 426: this build is too old (or blocked, or sent no version header) for this write. */
  | "upgrade_required"
  /** 409 with a slice-specific code (idempotency_conflict, outcome_conflict, class_full, already_enrolled, duplicate_email, payment_required ...). `serverCode` has the code, `current` the server state. */
  | "conflict"
  /** Client-side: no response at all (offline, DNS, TLS). */
  | "network_error"
  /** Client-side: a response that is not the contract's JSON. */
  | "unexpected_response";

export class StaffApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: StaffApiErrorCode,
    message: string,
    /** Seconds from a 429's Retry-After header, when it sent a usable one. */
    readonly retryAfterSeconds?: number,
    /** Write refusals: the raw server code (for a `conflict`) and the server's current state of the thing the app tried to change. */
    readonly extra?: { serverCode?: string; current?: unknown; /** The rest of a flat error body (for example duplicate_client: existingClientId, matchedOn). Never rendered as text. */ details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "StaffApiError";
  }
}

/** What a screen should do about a failure. Each kind has its own copy and recovery. */
export type StaffErrorKind =
  | "sign_in_again"
  | "account_inactive"
  | "platform_admin"
  | "no_access"
  | "paused"
  | "not_permitted"
  | "not_found"
  | "not_markable"
  | "rate_limited"
  | "writes_disabled"
  | "upgrade_required"
  | "conflict"
  | "unavailable"
  | "client_bug";

const KNOWN_CODES: readonly StaffApiErrorCode[] = [
  "unauthenticated",
  "account_inactive",
  "platform_admin_unsupported",
  "invalid_request",
  "not_a_member",
  "workspace_paused",
  "role_not_permitted",
  "not_found",
  "service_unavailable",
  "not_markable",
  "rate_limited",
  "writes_disabled",
  "upgrade_required",
];

/**
 * 409 codes the Phase 1A write routes use (the registry is "Write error codes" in Staff_API_Contract.md; a slice adds its codes here when it lands). Any other 409 keeps
 * the v0.1 meaning, not_markable, so an unknown or malformed body can never be read as something the screen would act on.
 */
const CONFLICT_CODES: readonly string[] = [
  "idempotency_conflict",
  "outcome_conflict",
  "payment_required",
  "duplicate_email",
  "already_enrolled",
  "class_full",
  "class_cancelled",
  "entitlement_exhausted",
  "no_eligible_entitlement",
  "membership_not_active",
  "membership_requires_selection",
  "ambiguous_funding_source",
  "attendee_attendance_recorded",
  "duplicate_client",
  "terminal_outcome",
  "usage_sync_pending",
  "charge_failed",
  "package_exhausted",
  "enrollment_failed",
  "invalid_funding",
  "attendance_recorded",
];

/** The server's `code` decides; the status is only a fallback for a body without one. */
function codeFor(status: number, raw: unknown): StaffApiErrorCode {
  if (typeof raw === "string" && (KNOWN_CODES as readonly string[]).includes(raw)) {
    return raw as StaffApiErrorCode;
  }
  if (status === 426) return "upgrade_required";
  // a 409 that names a slice-specific code is a conflict the screen can reconcile; a 409 with no code keeps the v0.1 meaning (not_markable)
  if (status === 409 && typeof raw === "string" && CONFLICT_CODES.includes(raw)) return "conflict";
  if (status === 401) return "unauthenticated";
  if (status === 404) return "not_found";
  if (status === 400) return "invalid_request";
  if (status === 403) return "not_a_member";
  if (status === 409) return "not_markable";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "service_unavailable";
  return "unexpected_response";
}

/**
 * The contract's error shape is flat: `{ error: "<message>", code: "<code>" }`. A nested `{ error: { code, message } }` is still
 * read defensively, because an unknown body must never crash the error path.
 */
export function readErrorBody(body: unknown): { code: unknown; message: string | null; current?: unknown } {
  const record = (body ?? {}) as { code?: unknown; error?: unknown; message?: unknown; current?: unknown };
  if (record.error && typeof record.error === "object") {
    const nested = record.error as { code?: unknown; message?: unknown };
    return { code: nested.code ?? record.code, message: typeof nested.message === "string" ? nested.message : null };
  }
  return {
    code: record.code,
    message: typeof record.error === "string" ? record.error : typeof record.message === "string" ? record.message : null,
    current: record.current,
  };
}

/** Fields of a flat error body besides error / code / current / message. */
function errorDetails(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const { error: _e, code: _c, current: _u, message: _m, ...rest } = body as Record<string, unknown>;
  return Object.keys(rest).length ? rest : undefined;
}

export function staffErrorKind(error: unknown): StaffErrorKind {
  if (!(error instanceof StaffApiError)) return "unavailable";

  switch (error.code) {
    case "unauthenticated":
      return "sign_in_again";
    case "account_inactive":
      return "account_inactive";
    case "platform_admin_unsupported":
      return "platform_admin";
    case "not_a_member":
      return "no_access";
    case "workspace_paused":
      return "paused";
    case "role_not_permitted":
      return "not_permitted";
    case "not_found":
      return "not_found";
    case "not_markable":
      return "not_markable";
    case "rate_limited":
      return "rate_limited";
    case "writes_disabled":
      return "writes_disabled";
    case "upgrade_required":
      return "upgrade_required";
    case "conflict":
      return "conflict";
    case "invalid_request":
      return "client_bug";
    case "service_unavailable":
    case "network_error":
    case "unexpected_response":
      return "unavailable";
  }
}

export type StaffApiOptions = {
  /** Origin serving /api/staff, e.g. https://idanceflow.com. */
  baseUrl: string;
  /** The current access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /** Refreshes the session and returns the new access token, or null if it cannot. */
  refreshAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Sent as X-DanceFlow-App on every request: business/<version>/<code>/<platform> (see appVersion.ts). Omitted when unknown; the server then refuses gated writes with upgrade_required. */
  appHeader?: string | null;
  /** Waits between a 429 and its one automatic retry. Injected so tests do not sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
};

/** A 429 whose Retry-After is this short or shorter is waited out once, for a read. Anything longer is shown to the person instead of stalling a screen. */
export const MAX_AUTO_RETRY_AFTER_SECONDS = 5;
/** The longest Retry-After the client will report back, so a bad header cannot promise an hour. */
const MAX_REPORTED_RETRY_AFTER_SECONDS = 120;

/** Retry-After as whole seconds (the server sends delta-seconds), or undefined when absent or unusable. */
export function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value || !/^\d{1,6}$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  return seconds > 0 ? Math.min(seconds, MAX_REPORTED_RETRY_AFTER_SECONDS) : undefined;
}

/*
  SLICE 2 (client lookup and attendance), final contract: docs/mobile/Staff_API_Contract.md on claude/staff-api-slice2
  (2b071403). Not served yet, so the features stay dark (src/lib/features.ts). The wire format is known only to this
  section and the adapters below; screens use these types, never raw JSON.
*/

export type ClientSummary = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  /** CRM status (lead, contacted, consultation_booked, converted, lost, active, inactive, archived). Always active for front desk; null for instructors: hide it. */
  status: string | null;
};

export type ClientPage = { clients: ClientSummary[]; nextCursor: string | null };

export type ClientPackageItem = { usageType: string; remaining: number | null; unlimited: boolean };

export type ClientPackage = { id: string; name: string; expiresOn: string | null; items: ClientPackageItem[] };

export type ClientDetail = ClientSummary & {
  /** Remaining counts only, never prices or payments. `null` for instructors, who can't see package balances: hide the section, don't show it empty. */
  activePackages: ClientPackage[] | null;
  /** Earliest upcoming scheduled / confirmed / rescheduled appointment. For instructors only their own lessons with this client. */
  nextAppointment: { id: string; appointmentType: string; title: string | null; startsAt: string; endsAt: string | null } | null;
  /** The studio's IANA zone, for rendering nextAppointment. */
  timeZone: string | null;
};

/**
 * The attendance values the app can write. They must be values of the existing roster attendance set
 * (registered | checked_in | attended | no_show | cancelled, src/lib/schedule/groupClassRosterPanel.ts); attended and
 * no_show are the recorded outcomes the web uses. The slice-2 contract accepts exactly these two (anything else is 400):
 * change it here only.
 */
export const ATTENDANCE_MARKS = ["attended", "no_show"] as const;
export type AttendanceMark = (typeof ATTENDANCE_MARKS)[number];

export type AttendanceResult = { clientId: string; attendanceStatus: string | null; displayName: string | null; updatedAt: string | null };

export type ClientNote = { id: string; clientId: string; noteType: string; body: string; occurredAt: string; createdAt: string };
export const CLIENT_NOTE_TYPES = ["general", "follow_up", "sales", "lesson", "billing", "concern"] as const;
export type ClientNoteType = (typeof CLIENT_NOTE_TYPES)[number];

export type NewClientInput = {
  /** Generated once per new client (newEntityId) and resent unchanged on every retry. */
  clientId: string;
  firstName: string;
  lastName: string;
  /** A phone or an email is required. */
  phone?: string;
  email?: string;
  note?: string;
  allowDuplicatePhone?: boolean;
};

export type AppointmentOutcome = "attended" | "no_show";
export type MissedCharge = "none" | "package" | "membership";
export type OutcomeResult = { id: string; status: string; alreadyApplied: boolean };

export type ClientNoteEntry = ClientNote & { authorName: string | null; isMine: boolean };
export type ClientNotesPage = { notes: ClientNoteEntry[]; nextCursor: string | null };
export type RosterBilling = "package_credit" | "pay_as_you_go" | "free_comped";
export type RosterEnrollResult = { attendeeId: string; clientId: string; alreadyEnrolled: boolean };
export type RosterRemoveResult = { removed: boolean; alreadyApplied: boolean };

export type StaffApi = {
  me: () => Promise<StaffMe>;
  today: (studioId: string, date?: string) => Promise<StaffToday>;
  appointment: (studioId: string, appointmentId: string) => Promise<AppointmentDetail>;
  /** Slice 3: GET /workspaces/{id}/schedule?date=. The whole studio's day for owner, admin and front desk; instructors get 403 role_not_permitted. */
  studioSchedule: (studioId: string, date?: string) => Promise<StaffStudioDay>;
  /** Slice 3: GET /workspaces/{id}/pulse. Counts and the next appointment; studio scope for owner, admin and front desk, own scope for an instructor. */
  pulse: (studioId: string, options?: { cards?: boolean }) => Promise<StaffPulse>;
  /** Slice 2: GET /workspaces/{id}/clients?q=&cursor=&limit= (limit 1–50). Front desk and admins: active clients. Instructors: the clients they teach. */
  searchClients: (studioId: string, params: { q?: string; cursor?: string | null; limit?: number }) => Promise<ClientPage>;
  /** Slice 2: GET /workspaces/{id}/clients/{clientId}. An instructor gets 404 for a client they don't teach. */
  client: (studioId: string, clientId: string) => Promise<ClientDetail>;
  /** Slice 2: PUT /workspaces/{id}/appointments/{appointmentId}/attendance/{clientId}. Idempotency-Key required (400 without); idempotent by state. */
  setAttendance: (
    studioId: string,
    appointmentId: string,
    clientId: string,
    status: AttendanceMark,
    idempotencyKey: string,
  ) => Promise<AttendanceResult>;
  /** Phase 1A S1: PUT /workspaces/{id}/appointments/{appointmentId}/attendance. One-to-one lessons only. Attended and no-show are FINAL (409 outcome_conflict on a flip); there is no reset. */
  setAppointmentOutcome: (
    studioId: string,
    appointmentId: string,
    input: { status: AppointmentOutcome; missedAppointmentCharge?: MissedCharge },
    idempotencyKey: string,
  ) => Promise<OutcomeResult>;
  /** Client notes read: GET /workspaces/{id}/clients/{clientId}/notes?cursor=&limit= (newest first). Owner, admin, front desk. */
  clientNotes: (studioId: string, clientId: string, params?: { cursor?: string | null; limit?: number }) => Promise<ClientNotesPage>;
  /** Phase 1A S2: POST /workspaces/{id}/appointments/{appointmentId}/roster. Natural key: a dancer already enrolled is 200 alreadyEnrolled. A package credit is taken later, at attendance. */
  enrollInClass: (studioId: string, appointmentId: string, input: { clientId: string; billingType?: RosterBilling }, idempotencyKey: string) => Promise<RosterEnrollResult>;
  /** Phase 1A S2: DELETE /workspaces/{id}/appointments/{appointmentId}/roster/{clientId}. Already removed is 200 alreadyApplied; recorded attendance is 409 attendance_recorded. */
  removeFromClass: (studioId: string, appointmentId: string, clientId: string, idempotencyKey: string) => Promise<RosterRemoveResult>;
  /** Phase 1A C1: POST /workspaces/{id}/clients/{clientId}/notes. `noteId` is generated once per note and resent on retries; 201 new, 200 replay. Owner, admin, front desk. */
  addClientNote: (
    studioId: string,
    clientId: string,
    input: { noteId: string; body: string; noteType?: ClientNoteType },
    idempotencyKey: string,
  ) => Promise<{ note: ClientNote }>;
  /** Phase 1A C2: POST /workspaces/{id}/clients (quick add). `clientId` is generated once per new client and resent on retries. A duplicate phone or email is 409 duplicate_client. */
  createClient: (studioId: string, input: NewClientInput, idempotencyKey: string) => Promise<{ client: ClientSummary; replayed: boolean }>;
};

const str = (value: unknown) => (typeof value === "string" ? value : null);

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

const person = (raw: unknown): PersonName | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  return id ? { id, firstName: str(r.firstName), lastName: str(r.lastName) } : null;
};

/** The studio-day wire format, normalised: a row without an id or start time is dropped rather than half-shown. */
export function toStaffStudioDay(raw: unknown): StaffStudioDay {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(r.appointments) ? r.appointments : [];
  const appointments: StudioAppointment[] = [];
  for (const row of rows) {
    const a = (row ?? {}) as Record<string, unknown>;
    const id = str(a.id);
    const startsAt = str(a.startsAt);
    if (!id || !startsAt) continue;
    const room = a.room && typeof a.room === "object" ? (a.room as Record<string, unknown>) : null;
    appointments.push({
      id,
      title: str(a.title),
      appointmentType: str(a.appointmentType) ?? "",
      status: str(a.status) ?? "",
      startsAt,
      endsAt: str(a.endsAt) ?? startsAt,
      room: room && str(room.id) ? { id: String(room.id), name: str(room.name) ?? "" } : null,
      locationName: str(a.locationName),
      client: person(a.client),
      partner: person(a.partner),
      instructor: person(a.instructor),
    });
  }
  return { studioId: str(r.studioId) ?? "", date: str(r.date) ?? "", timeZone: str(r.timeZone) ?? "", truncated: r.truncated === true, appointments };
}

/** The pulse wire format, normalised: a missing or malformed number is 0, never NaN on screen, and an unknown scope is the narrower "own". */
export function toStaffPulse(raw: unknown): StaffPulse {
  const r = (raw ?? {}) as Record<string, unknown>;
  const today = (r.today ?? {}) as Record<string, unknown>;
  const next = r.next && typeof r.next === "object" ? (r.next as Record<string, unknown>) : null;
  const nextId = next ? str(next.id) : null;
  const startsAt = next ? str(next.startsAt) : null;
  return {
    studioId: str(r.studioId) ?? "",
    timeZone: str(r.timeZone) ?? "",
    date: str(r.date) ?? "",
    asOf: str(r.asOf) ?? "",
    scope: r.scope === "studio" ? "studio" : "own",
    instructorId: str(r.instructorId),
    today: { total: count(today.total), upcoming: count(today.upcoming), cancelled: count(today.cancelled), truncated: today.truncated === true },
    next:
      next && nextId && startsAt
        ? {
            id: nextId,
            appointmentType: str(next.appointmentType) ?? "",
            title: str(next.title),
            status: str(next.status) ?? "",
            startsAt,
            endsAt: str(next.endsAt) ?? startsAt,
          }
        : null,
    newClientsLast7Days: r.scope === "studio" && typeof r.newClientsLast7Days === "number" ? count(r.newClientsLast7Days) : null,
    ...("cards" in r ? { cards: toPulseCards(r.cards) } : {}),
  };
}

function toClientSummary(raw: unknown): ClientSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { id: String(r.id ?? ""), firstName: str(r.firstName), lastName: str(r.lastName), status: str(r.status) };
}

/** Adapters: the only place that knows the wire format. */
export function toClientPage(raw: unknown): ClientPage {
  const r = (raw ?? {}) as { clients?: unknown; nextCursor?: unknown };
  const clients = Array.isArray(r.clients) ? r.clients.map(toClientSummary).filter((c) => c.id) : [];
  return { clients, nextCursor: str(r.nextCursor) };
}

function toNextAppointment(next: unknown): ClientDetail["nextAppointment"] {
  if (!next || typeof next !== "object") return null;
  const n = next as Record<string, unknown>;
  const id = str(n.id);
  const startsAt = str(n.startsAt);
  if (!id || !startsAt) return null;
  return { id, appointmentType: str(n.appointmentType) ?? "appointment", title: str(n.title), startsAt, endsAt: str(n.endsAt) };
}

function toPackage(raw: unknown): ClientPackage | null {
  const p = (raw ?? {}) as Record<string, unknown>;
  const id = str(p.id);
  const name = str(p.name);
  if (!id || !name) return null;
  const items = (Array.isArray(p.items) ? p.items : []).map((item) => {
    const i = (item ?? {}) as Record<string, unknown>;
    return {
      usageType: str(i.usageType) ?? "other",
      remaining: typeof i.remaining === "number" && Number.isFinite(i.remaining) ? i.remaining : null,
      unlimited: i.unlimited === true,
    };
  });
  return { id, name, expiresOn: str(p.expiresOn), items };
}

/** Slice 2: `{ client: {...}, timeZone, activePackages, nextAppointment }`. */
export function toClientDetail(raw: unknown): ClientDetail {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ...toClientSummary(r.client),
    // null (instructor) stays null so the screen can hide the section; an array is filtered to well-formed packages
    activePackages: Array.isArray(r.activePackages)
      ? r.activePackages.map(toPackage).filter((p): p is ClientPackage => p !== null)
      : null,
    nextAppointment: toNextAppointment(r.nextAppointment),
    timeZone: str(r.timeZone),
  };
}

/** Slice 2: `{ attendee: { clientId, displayName, status, updatedAt } }`. */
export function toAttendanceResult(raw: unknown, clientId: string): AttendanceResult {
  const outer = (raw ?? {}) as Record<string, unknown>;
  const r = (outer.attendee && typeof outer.attendee === "object" ? outer.attendee : outer) as Record<string, unknown>;
  return {
    clientId: str(r.clientId) ?? clientId,
    attendanceStatus: str(r.status) ?? str(r.attendanceStatus),
    displayName: str(r.displayName),
    updatedAt: str(r.updatedAt),
  };
}

type RequestOptions = { method?: "GET" | "PUT" | "POST" | "DELETE"; body?: unknown; headers?: Record<string, string> };

export function createStaffApi(options: StaffApiOptions): StaffApi {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function send(path: string, token: string, request: RequestOptions) {
    try {
      return await doFetch(`${baseUrl}/api/staff${path}`, {
        method: request.method ?? "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(options.appHeader ? { "X-DanceFlow-App": options.appHeader } : {}),
          ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...request.headers,
        },
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      });
    } catch {
      throw new StaffApiError(0, "network_error", "We could not reach DanceFlow.");
    }
  }

  /** A retry after a 401 refresh resends the same request, including its Idempotency-Key, so a write can never apply twice. */
  async function call<T>(path: string, request: RequestOptions = {}): Promise<T> {
    const token = await options.getAccessToken();
    if (!token) throw new StaffApiError(401, "unauthenticated", "Sign in to continue.");

    let response = await send(path, token, request);
    let refreshed: string | null = null;

    if (response.status === 401) {
      refreshed = await options.refreshAccessToken().catch(() => null);
      if (!refreshed) throw new StaffApiError(401, "unauthenticated", "Sign in to continue.");
      response = await send(path, refreshed, request);
    }

    let retryAfterSeconds: number | undefined;
    if (response.status === 429) {
      retryAfterSeconds = parseRetryAfterSeconds(response.headers?.get?.("Retry-After"));
      // A 429 is refused before any work, so resending is safe. Only a read waits and retries on its own, once, and only for a short wait:
      // a write (a row that is saving) is left to the person's next tap, which keeps one mark = one action.
      const isRead = (request.method ?? "GET") === "GET";
      if (isRead && retryAfterSeconds !== undefined && retryAfterSeconds <= MAX_AUTO_RETRY_AFTER_SECONDS) {
        await sleep(retryAfterSeconds * 1000);
        response = await send(path, refreshed ?? token, request);
        if (response.status === 429) retryAfterSeconds = parseRetryAfterSeconds(response.headers?.get?.("Retry-After"));
      }
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const { code, message, current } = readErrorBody(body);
      throw new StaffApiError(response.status, codeFor(response.status, code), message ?? "Something went wrong.", retryAfterSeconds, {
        serverCode: typeof code === "string" ? code : undefined,
        current,
        details: errorDetails(body),
      });
    }

    if (body === null || typeof body !== "object") {
      throw new StaffApiError(response.status, "unexpected_response", "Something went wrong.");
    }

    return body as T;
  }

  const ws = (studioId: string) => `/workspaces/${encodeURIComponent(studioId)}`;

  return {
    me: () => call<StaffMe>("/me"),
    today: (studioId, date) => call<StaffToday>(`${ws(studioId)}/today${date ? `?date=${encodeURIComponent(date)}` : ""}`),
    studioSchedule: async (studioId, date) =>
      toStaffStudioDay(await call<unknown>(`${ws(studioId)}/schedule${date ? `?date=${encodeURIComponent(date)}` : ""}`)),
    pulse: async (studioId, options) => toStaffPulse(await call<unknown>(`${ws(studioId)}/pulse${options?.cards ? "?include=cards" : ""}`)),
    appointment: (studioId, appointmentId) =>
      call<AppointmentDetail>(`${ws(studioId)}/appointments/${encodeURIComponent(appointmentId)}`),
    searchClients: async (studioId, { q, cursor, limit }) => {
      const query = new URLSearchParams();
      if (q?.trim()) query.set("q", q.trim());
      if (cursor) query.set("cursor", cursor);
      // the contract accepts 1–50
      if (limit && Number.isInteger(limit) && limit > 0) query.set("limit", String(Math.min(limit, 50)));
      const suffix = query.toString() ? `?${query.toString()}` : "";
      return toClientPage(await call<unknown>(`${ws(studioId)}/clients${suffix}`));
    },
    client: async (studioId, clientId) =>
      toClientDetail(await call<unknown>(`${ws(studioId)}/clients/${encodeURIComponent(clientId)}`)),
    setAppointmentOutcome: async (studioId, appointmentId, input, idempotencyKey) => {
      const raw = await call<{ appointment?: Record<string, unknown> }>(`${ws(studioId)}/appointments/${encodeURIComponent(appointmentId)}/attendance`, {
        method: "PUT",
        body: input,
        headers: { "Idempotency-Key": idempotencyKey },
      });
      const a = raw.appointment;
      if (!a || typeof a.status !== "string") throw new StaffApiError(200, "unexpected_response", "Something went wrong.");
      return { id: typeof a.id === "string" ? a.id : appointmentId, status: a.status, alreadyApplied: a.alreadyApplied === true };
    },
    clientNotes: async (studioId, clientId, params = {}) => {
      const query = new URLSearchParams();
      if (params.cursor) query.set("cursor", params.cursor);
      if (params.limit && Number.isInteger(params.limit) && params.limit > 0) query.set("limit", String(Math.min(params.limit, 50)));
      const suffix = query.toString() ? `?${query.toString()}` : "";
      const raw = await call<{ notes?: unknown; nextCursor?: unknown }>(`${ws(studioId)}/clients/${encodeURIComponent(clientId)}/notes${suffix}`);
      const notes = Array.isArray(raw.notes)
        ? raw.notes.flatMap((n: Record<string, unknown>) =>
            typeof n?.id === "string" && typeof n.body === "string"
              ? [{ id: n.id, clientId: typeof n.clientId === "string" ? n.clientId : clientId, noteType: str(n.noteType) ?? "general", body: n.body, occurredAt: str(n.occurredAt) ?? "", createdAt: str(n.createdAt) ?? "", authorName: str(n.authorName), isMine: n.isMine === true }]
              : [],
          )
        : [];
      return { notes, nextCursor: str(raw.nextCursor) };
    },
    enrollInClass: async (studioId, appointmentId, input, idempotencyKey) => {
      const raw = await call<{ attendee?: Record<string, unknown> }>(`${ws(studioId)}/appointments/${encodeURIComponent(appointmentId)}/roster`, {
        method: "POST",
        body: input,
        headers: { "Idempotency-Key": idempotencyKey },
      });
      const a = raw.attendee;
      if (!a || typeof a.id !== "string") throw new StaffApiError(200, "unexpected_response", "Something went wrong.");
      return { attendeeId: a.id, clientId: typeof a.clientId === "string" ? a.clientId : input.clientId, alreadyEnrolled: a.alreadyEnrolled === true };
    },
    removeFromClass: async (studioId, appointmentId, clientId, idempotencyKey) => {
      const raw = await call<{ removed?: unknown; alreadyApplied?: unknown }>(
        `${ws(studioId)}/appointments/${encodeURIComponent(appointmentId)}/roster/${encodeURIComponent(clientId)}`,
        { method: "DELETE", headers: { "Idempotency-Key": idempotencyKey } },
      );
      if (raw.removed !== true) throw new StaffApiError(200, "unexpected_response", "Something went wrong.");
      return { removed: true, alreadyApplied: raw.alreadyApplied === true };
    },
    addClientNote: async (studioId, clientId, input, idempotencyKey) => {
      const raw = await call<{ note?: Record<string, unknown> }>(`${ws(studioId)}/clients/${encodeURIComponent(clientId)}/notes`, {
        method: "POST",
        body: { noteId: input.noteId, body: input.body, ...(input.noteType ? { noteType: input.noteType } : {}) },
        headers: { "Idempotency-Key": idempotencyKey },
      });
      const n = raw.note;
      if (!n || typeof n.id !== "string") throw new StaffApiError(200, "unexpected_response", "Something went wrong.");
      return {
        note: {
          id: n.id,
          clientId: typeof n.clientId === "string" ? n.clientId : clientId,
          noteType: typeof n.noteType === "string" ? n.noteType : "general",
          body: typeof n.body === "string" ? n.body : input.body,
          occurredAt: typeof n.occurredAt === "string" ? n.occurredAt : "",
          createdAt: typeof n.createdAt === "string" ? n.createdAt : "",
        },
      };
    },
    createClient: async (studioId, input, idempotencyKey) => {
      const raw = await call<{ client?: unknown; replayed?: unknown }>(`${ws(studioId)}/clients`, {
        method: "POST",
        body: input,
        headers: { "Idempotency-Key": idempotencyKey },
      });
      if (!raw.client || typeof raw.client !== "object") throw new StaffApiError(200, "unexpected_response", "Something went wrong.");
      return { client: toClientSummary(raw.client), replayed: raw.replayed === true };
    },
    setAttendance: async (studioId, appointmentId, clientId, status, idempotencyKey) =>
      toAttendanceResult(
        await call<unknown>(
          `${ws(studioId)}/appointments/${encodeURIComponent(appointmentId)}/attendance/${encodeURIComponent(clientId)}`,
          { method: "PUT", body: { status }, headers: { "Idempotency-Key": idempotencyKey } },
        ),
        clientId,
      ),
  };
}

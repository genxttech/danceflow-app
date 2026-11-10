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

export type StaffToday = {
  studioId: string;
  date: string;
  timeZone: string;
  instructorId: string | null;
  appointments: TodayAppointment[];
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
  /** Client-side: no response at all (offline, DNS, TLS). */
  | "network_error"
  /** Client-side: a response that is not the contract's JSON. */
  | "unexpected_response";

export class StaffApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: StaffApiErrorCode,
    message: string,
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
];

/** The server's `code` decides; the status is only a fallback for a body without one. */
function codeFor(status: number, raw: unknown): StaffApiErrorCode {
  if (typeof raw === "string" && (KNOWN_CODES as readonly string[]).includes(raw)) {
    return raw as StaffApiErrorCode;
  }
  if (status === 401) return "unauthenticated";
  if (status === 404) return "not_found";
  if (status === 400) return "invalid_request";
  if (status === 403) return "not_a_member";
  if (status === 409) return "not_markable";
  if (status >= 500) return "service_unavailable";
  return "unexpected_response";
}

/**
 * The contract's error shape is flat: `{ error: "<message>", code: "<code>" }`. A nested `{ error: { code, message } }` is still
 * read defensively, because an unknown body must never crash the error path.
 */
export function readErrorBody(body: unknown): { code: unknown; message: string | null } {
  const record = (body ?? {}) as { code?: unknown; error?: unknown; message?: unknown };
  if (record.error && typeof record.error === "object") {
    const nested = record.error as { code?: unknown; message?: unknown };
    return { code: nested.code ?? record.code, message: typeof nested.message === "string" ? nested.message : null };
  }
  return {
    code: record.code,
    message: typeof record.error === "string" ? record.error : typeof record.message === "string" ? record.message : null,
  };
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
};

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

export type StaffApi = {
  me: () => Promise<StaffMe>;
  today: (studioId: string, date?: string) => Promise<StaffToday>;
  appointment: (studioId: string, appointmentId: string) => Promise<AppointmentDetail>;
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
};

const str = (value: unknown) => (typeof value === "string" ? value : null);

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

type RequestOptions = { method?: "GET" | "PUT"; body?: unknown; headers?: Record<string, string> };

export function createStaffApi(options: StaffApiOptions): StaffApi {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  async function send(path: string, token: string, request: RequestOptions) {
    try {
      return await doFetch(`${baseUrl}/api/staff${path}`, {
        method: request.method ?? "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
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

    if (response.status === 401) {
      const refreshed = await options.refreshAccessToken().catch(() => null);
      if (!refreshed) throw new StaffApiError(401, "unauthenticated", "Sign in to continue.");
      response = await send(path, refreshed, request);
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const { code, message } = readErrorBody(body);
      throw new StaffApiError(response.status, codeFor(response.status, code), message ?? "Something went wrong.");
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

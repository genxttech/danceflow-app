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
  if (status >= 500) return "service_unavailable";
  return "unexpected_response";
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
  PROPOSED SHAPES (v2: client lookup and attendance). Not served yet: the Staff API session is building these
  endpoints. Everything that depends on the final wire format is in this section and in the adapters below, so
  a different final shape changes only this file. Screens use these types, never raw JSON.
*/

export type ClientSummary = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  /** e.g. active, inactive, lead. Displayed as words; unknown values pass through. */
  status: string | null;
};

export type ClientPage = { clients: ClientSummary[]; nextCursor: string | null };

export type ClientDetail = ClientSummary & {
  /** The next lesson or class this client is booked into at this studio, if any. No money, no contact details. */
  nextAppointment: { id: string; startsAt: string; appointmentType: string } | null;
};

export type AttendanceMark = "attended" | "absent";

export type AttendanceResult = { clientId: string; attendanceStatus: string | null };

export type StaffApi = {
  me: () => Promise<StaffMe>;
  today: (studioId: string, date?: string) => Promise<StaffToday>;
  appointment: (studioId: string, appointmentId: string) => Promise<AppointmentDetail>;
  /** PROPOSED: GET /workspaces/{id}/clients?q=&cursor= */
  searchClients: (studioId: string, params: { q?: string; cursor?: string | null }) => Promise<ClientPage>;
  /** PROPOSED: GET /workspaces/{id}/clients/{clientId} */
  client: (studioId: string, clientId: string) => Promise<ClientDetail>;
  /** PROPOSED: PUT /workspaces/{id}/appointments/{appointmentId}/attendance/{clientId}, with an Idempotency-Key header. */
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

/** Adapters: the only place that knows the proposed wire format. */
export function toClientPage(raw: unknown): ClientPage {
  const r = (raw ?? {}) as { clients?: unknown; nextCursor?: unknown };
  const clients = Array.isArray(r.clients) ? r.clients.map(toClientSummary).filter((c) => c.id) : [];
  return { clients, nextCursor: str(r.nextCursor) };
}

export function toClientDetail(raw: unknown): ClientDetail {
  const r = (raw ?? {}) as { nextAppointment?: unknown };
  const next = (r.nextAppointment ?? null) as Record<string, unknown> | null;
  return {
    ...toClientSummary(raw),
    nextAppointment:
      next && typeof next.id === "string" && typeof next.startsAt === "string"
        ? { id: next.id, startsAt: next.startsAt, appointmentType: str(next.appointmentType) ?? "appointment" }
        : null,
  };
}

export function toAttendanceResult(raw: unknown, clientId: string): AttendanceResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { clientId: str(r.clientId) ?? clientId, attendanceStatus: str(r.attendanceStatus) };
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
      const record = (body ?? {}) as { code?: unknown; error?: unknown };
      const message = typeof record.error === "string" ? record.error : "Something went wrong.";
      throw new StaffApiError(response.status, codeFor(response.status, record.code), message);
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
    searchClients: async (studioId, { q, cursor }) => {
      const query = new URLSearchParams();
      if (q?.trim()) query.set("q", q.trim());
      if (cursor) query.set("cursor", cursor);
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

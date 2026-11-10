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

export type StaffApi = {
  me: () => Promise<StaffMe>;
  today: (studioId: string, date?: string) => Promise<StaffToday>;
  appointment: (studioId: string, appointmentId: string) => Promise<AppointmentDetail>;
};

export function createStaffApi(options: StaffApiOptions): StaffApi {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  async function send(path: string, token: string) {
    try {
      return await doFetch(`${baseUrl}/api/staff${path}`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new StaffApiError(0, "network_error", "We could not reach DanceFlow.");
    }
  }

  async function get<T>(path: string): Promise<T> {
    const token = await options.getAccessToken();
    if (!token) throw new StaffApiError(401, "unauthenticated", "Sign in to continue.");

    let response = await send(path, token);

    if (response.status === 401) {
      const refreshed = await options.refreshAccessToken().catch(() => null);
      if (!refreshed) throw new StaffApiError(401, "unauthenticated", "Sign in to continue.");
      response = await send(path, refreshed);
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

  return {
    me: () => get<StaffMe>("/me"),
    today: (studioId, date) =>
      get<StaffToday>(
        `/workspaces/${encodeURIComponent(studioId)}/today${date ? `?date=${encodeURIComponent(date)}` : ""}`,
      ),
    appointment: (studioId, appointmentId) =>
      get<AppointmentDetail>(
        `/workspaces/${encodeURIComponent(studioId)}/appointments/${encodeURIComponent(appointmentId)}`,
      ),
  };
}

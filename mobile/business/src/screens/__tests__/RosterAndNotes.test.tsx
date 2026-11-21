import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { createStaffApi, StaffApiError, type AppointmentDetail, type ClientDetail } from "@/lib/staffApi";
import { AppointmentScreen } from "@/screens/AppointmentScreen";
import { ClientDetailScreen } from "@/screens/ClientDetailScreen";
import { auditA11y } from "@/test-utils/a11y";
import { deferred, fakeApi, STUDIO_ID, StaffTestProviders, workspace } from "@/test-utils/staff";

jest.setTimeout(40_000);

const flags = { classRoster: true, clientNotes: true };
jest.mock("@/lib/features", () => ({
  ...jest.requireActual("@/lib/features"),
  isStaffFeatureEnabled: (feature: string) => (feature === "classRoster" ? flags.classRoster : feature === "clientNotes" ? flags.clientNotes : true),
}));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});

const EDITOR = workspace({ capabilities: { viewStudioSchedule: true, viewClients: true, markAttendance: true, editClients: true, editAppointments: true } as never });

const CLASS = (attendees = [{ clientId: "c1", name: "Ana Rivera", attendanceStatus: null as string | null }, { clientId: "c2", name: "Colin Marsh", attendanceStatus: "attended" as string | null }]): AppointmentDetail =>
  ({
    id: "class-1",
    title: "Beginner Salsa",
    appointmentType: "group_class",
    status: "scheduled",
    startsAt: "2026-11-20T23:00:00.000Z",
    endsAt: "2026-11-21T00:00:00.000Z",
    room: null,
    locationName: null,
    client: null,
    partner: null,
    studioId: STUDIO_ID,
    timeZone: "America/New_York",
    accessScope: "broad",
    notes: null,
    instructor: null,
    roster: { bookedCount: attendees.length, capacity: 10, attendees },
    recap: null,
  }) as AppointmentDetail;

const CLIENTS = [
  { id: "c1", firstName: "Ana", lastName: "Rivera", status: "active" },
  { id: "c7", firstName: "Dee", lastName: "Park", status: "active" },
];

async function renderClass(over: Record<string, jest.Mock> = {}, ws = EDITOR) {
  const api = fakeApi({
    appointment: jest.fn(async () => CLASS()),
    searchClients: jest.fn(async () => ({ clients: CLIENTS, nextCursor: null })),
    enrollInClass: jest.fn(async () => ({ attendeeId: "att-7", clientId: "c7", alreadyEnrolled: false })),
    removeFromClass: jest.fn(async () => ({ removed: true, alreadyApplied: false })),
    ...over,
  });
  render(
    <StaffTestProviders api={api} ws={ws}>
      <AppointmentScreen appointmentId="class-1" studioId={STUDIO_ID} />
    </StaffTestProviders>,
  );
  await act(async () => undefined);
  return api;
}

async function chooseDee() {
  fireEvent.press(screen.getByLabelText("Add a dancer"));
  fireEvent.changeText(screen.getByTestId("dancer-search"), "dee");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  fireEvent.press(screen.getByTestId("dancer-c7"));
}

beforeEach(() => {
  flags.classRoster = true;
  flags.clientNotes = true;
  jest.clearAllMocks();
});

describe("roster: add a dancer", () => {
  it("searches (hiding dancers already on the roster), picks one, defaults to package credit, and adds with one request", async () => {
    const api = await renderClass();
    await chooseDee();
    expect(api.searchClients).toHaveBeenCalledWith(STUDIO_ID, { q: "dee", limit: 10 });
    expect(screen.queryByTestId("dancer-c1")).toBeNull(); // Ana is already enrolled
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Add to class"));
    });
    expect(api.enrollInClass).toHaveBeenCalledTimes(1);
    const [studio, appt, input, key] = api.enrollInClass.mock.calls[0] as unknown as [string, string, Record<string, unknown>, string];
    expect([studio, appt]).toEqual([STUDIO_ID, "class-1"]);
    expect(input).toEqual({ clientId: "c7", billingType: "package_credit" });
    expect(key).toMatch(/^df-bus-/);
    expect(screen.getByTestId("roster-change").props.children).toBe("Dancer added.");
    expect(screen.getByTestId("attendee-c7")).toBeTruthy();
    expect(screen.getByTestId("roster-capacity").props.children).toBe("3 of 10 booked");
  });

  it("sends the chosen way to pay", async () => {
    const api = await renderClass();
    await chooseDee();
    fireEvent.press(screen.getByTestId("funding-free_comped"));
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Add to class"));
    });
    expect(api.enrollInClass.mock.calls[0][2]).toEqual({ clientId: "c7", billingType: "free_comped" });
  });

  it("a double tap sends one request", async () => {
    const d = deferred<{ attendeeId: string; clientId: string; alreadyEnrolled: boolean }>();
    const api = await renderClass({ enrollInClass: jest.fn(() => d.promise) });
    await chooseDee();
    fireEvent.press(screen.getByLabelText("Add to class"));
    fireEvent.press(screen.getByLabelText("Add to class"));
    expect(api.enrollInClass).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve({ attendeeId: "a", clientId: "c7", alreadyEnrolled: false }));
  });

  it("a dancer who is already enrolled is a quiet success, not a second row", async () => {
    await renderClass({ enrollInClass: jest.fn(async () => ({ attendeeId: "att-7", clientId: "c7", alreadyEnrolled: true })) });
    await chooseDee();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Add to class"));
    });
    expect(screen.getByTestId("roster-change").props.children).toBe("That dancer was already on the roster.");
    expect(screen.queryByTestId("attendee-c7")).toBeNull();
    expect(screen.getByTestId("roster-capacity").props.children).toBe("2 of 10 booked");
  });

  it.each([
    ["class_full", "The class is full"],
    ["class_cancelled", "The class is cancelled"],
    ["no_eligible_entitlement", "No package or membership"],
    ["entitlement_exhausted", "Nothing left to use"],
    ["ambiguous_funding_source", "Needs a billing decision"],
    ["invalid_funding", "That package doesn't fit"],
    ["membership_not_active", "Membership not active"],
  ])("%s is said in words and adds nobody", async (serverCode, title) => {
    await renderClass({ enrollInClass: jest.fn(async () => Promise.reject(new StaffApiError(409, "conflict", "x", undefined, { serverCode, current: null }))) });
    await chooseDee();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Add to class"));
    });
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByLabelText("Retry")).toBeNull();
    expect(screen.queryByTestId("attendee-c7")).toBeNull();
  });

  it("a lost answer retries with the same key", async () => {
    const enroll = jest
      .fn()
      .mockRejectedValueOnce(new StaffApiError(0, "network_error", "x"))
      .mockResolvedValueOnce({ attendeeId: "att-7", clientId: "c7", alreadyEnrolled: true });
    await renderClass({ enrollInClass: enroll });
    await chooseDee();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Add to class"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Try again"));
    });
    expect(enroll.mock.calls[1][3]).toBe(enroll.mock.calls[0][3]);
  });

  it("is hidden behind the flag, for an instructor, and for a cancelled class", async () => {
    flags.classRoster = false;
    await renderClass();
    expect(screen.queryByLabelText("Add a dancer")).toBeNull();
    screen.unmount();
    flags.classRoster = true;
    await renderClass({}, workspace({ role: "instructor", capabilities: EDITOR.capabilities }));
    expect(screen.queryByLabelText("Add a dancer")).toBeNull();
    screen.unmount();
    await renderClass({ appointment: jest.fn(async () => ({ ...CLASS(), status: "cancelled" })) });
    expect(screen.queryByLabelText("Add a dancer")).toBeNull();
  });

  it("passes the static accessibility audit with the sheet open", async () => {
    await renderClass();
    await chooseDee();
    expect(auditA11y(screen.UNSAFE_root)).toEqual([]);
  });
});

describe("roster: remove a dancer", () => {
  it("only offers Remove where no attendance is recorded, asks first, then removes and updates the count", async () => {
    const api = await renderClass();
    expect(screen.getByLabelText("Remove Ana Rivera from the class")).toBeTruthy();
    expect(screen.queryByLabelText("Remove Colin Marsh from the class")).toBeNull(); // attended
    fireEvent.press(screen.getByLabelText("Remove Ana Rivera from the class"));
    expect(api.removeFromClass).not.toHaveBeenCalled();
    expect(screen.getByText("Remove Ana Rivera from the class?")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Yes, remove"));
    });
    expect(api.removeFromClass).toHaveBeenCalledTimes(1);
    expect((api.removeFromClass.mock.calls[0] as unknown[]).slice(0, 3)).toEqual([STUDIO_ID, "class-1", "c1"]);
    expect(screen.getByTestId("roster-change").props.children).toBe("Dancer removed.");
    expect(screen.queryByText("Ana Rivera")).toBeNull();
    expect(screen.getByTestId("roster-capacity").props.children).toBe("1 of 10 booked");
  });

  it("attendance_recorded keeps the dancer and says why", async () => {
    await renderClass({ removeFromClass: jest.fn(async () => Promise.reject(new StaffApiError(409, "conflict", "x", undefined, { serverCode: "attendance_recorded", current: null }))) });
    fireEvent.press(screen.getByLabelText("Remove Ana Rivera from the class"));
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Yes, remove"));
    });
    expect(screen.getByText("Can't remove this dancer")).toBeTruthy();
    expect(screen.getByText("Ana Rivera")).toBeTruthy();
  });

  it("no Remove buttons without the flag", async () => {
    flags.classRoster = false;
    await renderClass();
    expect(screen.queryByLabelText("Remove Ana Rivera from the class")).toBeNull();
  });
});

describe("client notes list", () => {
  const DETAIL: ClientDetail = { id: "c1", firstName: "Ana", lastName: "Rivera", status: "active", timeZone: "America/New_York", activePackages: [], nextAppointment: null };
  const NOTES = [
    { id: "n2", clientId: "c1", noteType: "follow_up", body: "Call back Friday", occurredAt: "2026-11-20T15:30:00+00:00", createdAt: "2026-11-20T15:30:02+00:00", authorName: "Fran Desk", isMine: true },
    { id: "n1", clientId: "c1", noteType: "general", body: "Met at the showcase", occurredAt: "2026-11-18T15:30:00+00:00", createdAt: "2026-11-18T15:30:02+00:00", authorName: null, isMine: false },
  ];

  async function renderDetail(clientNotes: jest.Mock, ws = EDITOR) {
    const api = fakeApi({ client: jest.fn(async () => DETAIL), clientNotes });
    render(
      <StaffTestProviders api={api} ws={ws}>
        <ClientDetailScreen clientId="c1" studioId={STUDIO_ID} />
      </StaffTestProviders>,
    );
    await act(async () => undefined);
    return api;
  }

  it("lists notes newest first with type, date in the studio zone and author (You / Staff when unknown)", async () => {
    await renderDetail(jest.fn(async () => ({ notes: NOTES, nextCursor: null })));
    const list = screen.getByTestId("notes-list");
    expect(list).toBeTruthy();
    expect(screen.getByText("Call back Friday")).toBeTruthy();
    expect(screen.getByText(/Follow-up · Nov 20, 2026, 10:30 AM · You/)).toBeTruthy();
    expect(screen.getByText(/General · Nov 18, 2026, 10:30 AM · Staff/)).toBeTruthy();
  });

  it("says No notes yet, pages with Show older notes (no duplicates), and re-reads after a note is saved", async () => {
    const empty = await renderDetail(jest.fn(async () => ({ notes: [], nextCursor: null })));
    expect(screen.getByTestId("notes-empty")).toBeTruthy();
    expect(empty.clientNotes).toHaveBeenCalledWith(STUDIO_ID, "c1", { limit: 20 });
    screen.unmount();
    const paged = jest.fn().mockResolvedValueOnce({ notes: [NOTES[0]], nextCursor: "CUR" }).mockResolvedValueOnce({ notes: [NOTES[0], NOTES[1]], nextCursor: null });
    await renderDetail(paged);
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Show older notes"));
    });
    expect(paged.mock.calls[1][2]).toEqual({ cursor: "CUR", limit: 20 });
    expect(screen.getAllByText("Call back Friday")).toHaveLength(1);
    expect(screen.getByText("Met at the showcase")).toBeTruthy();
    expect(screen.queryByLabelText("Show older notes")).toBeNull();
  });

  it("a failed read says so with a retry and does not hide the client", async () => {
    const read = jest.fn().mockRejectedValueOnce(new StaffApiError(503, "service_unavailable", "x")).mockResolvedValueOnce({ notes: NOTES, nextCursor: null });
    await renderDetail(read);
    expect(screen.getByText("Notes couldn't be loaded.")).toBeTruthy();
    expect(screen.getByText("Ana Rivera")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Try loading notes again"));
    });
    expect(screen.getByTestId("notes-list")).toBeTruthy();
  });

  it("is hidden behind the flag", async () => {
    flags.clientNotes = false;
    const read = jest.fn();
    await renderDetail(read);
    expect(screen.queryByTestId("client-notes")).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("staff API client: roster and notes read", () => {
  const res = (status: number, body: unknown) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body }) as unknown as Response;
  function api(...responses: Response[]) {
    const fetchImpl = jest.fn(async () => responses.shift()!);
    return { api: createStaffApi({ baseUrl: "https://x.test", getAccessToken: async () => "t", refreshAccessToken: async () => "t", fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: async () => {} }), fetchImpl };
  }
  const call = (f: jest.Mock, i = 0) => {
    const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
    return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
  };

  it("enroll POSTs clientId and billingType; remove DELETEs by client id; both carry the key", async () => {
    const a = api(res(201, { attendee: { id: "att", clientId: "c7", alreadyEnrolled: false } }), res(200, { removed: true, alreadyApplied: true }));
    expect(await a.api.enrollInClass("s", "ap", { clientId: "c7", billingType: "free_comped" }, "df-bus-key-12345678")).toEqual({ attendeeId: "att", clientId: "c7", alreadyEnrolled: false });
    expect(call(a.fetchImpl)).toMatchObject({ url: "https://x.test/api/staff/workspaces/s/appointments/ap/roster", method: "POST", body: { clientId: "c7", billingType: "free_comped" } });
    expect(call(a.fetchImpl).headers["Idempotency-Key"]).toBe("df-bus-key-12345678");
    expect(await a.api.removeFromClass("s", "ap", "c7", "df-bus-key-12345678")).toEqual({ removed: true, alreadyApplied: true });
    expect(call(a.fetchImpl, 1)).toMatchObject({ url: "https://x.test/api/staff/workspaces/s/appointments/ap/roster/c7", method: "DELETE" });
  });

  it("a body that is not the contract is unexpected_response", async () => {
    await expect(api(res(201, { nope: 1 })).api.enrollInClass("s", "ap", { clientId: "c" }, "df-bus-key-12345678")).rejects.toMatchObject({ code: "unexpected_response" });
    await expect(api(res(200, { removed: false })).api.removeFromClass("s", "ap", "c", "df-bus-key-12345678")).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("notes read maps the contract and clamps the limit", async () => {
    const a = api(res(200, { notes: [{ id: "n", clientId: "c", noteType: "sales", body: "hi", occurredAt: "o", createdAt: "c", authorName: "A", isMine: true }, { bad: true }], nextCursor: "X" }));
    const page = await a.api.clientNotes("s", "c", { cursor: "CUR", limit: 500 });
    expect(call(a.fetchImpl).url).toBe("https://x.test/api/staff/workspaces/s/clients/c/notes?cursor=CUR&limit=50");
    expect(page).toEqual({ notes: [{ id: "n", clientId: "c", noteType: "sales", body: "hi", occurredAt: "o", createdAt: "c", authorName: "A", isMine: true }], nextCursor: "X" });
  });
});

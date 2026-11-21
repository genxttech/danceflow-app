import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { ClientNoteSheet } from "@/components/ClientNoteSheet";
import { AddClientScreen, validateDraft } from "@/screens/AddClientScreen";
import { ClientDetailScreen } from "@/screens/ClientDetailScreen";
import { ClientsScreen } from "@/screens/ClientsScreen";
import { StaffApiError, type ClientDetail } from "@/lib/staffApi";
import { auditA11y } from "@/test-utils/a11y";
import { deferred, fakeApi, STUDIO_ID, StaffTestProviders, workspace } from "@/test-utils/staff";

jest.setTimeout(30_000);

const flags = { clientNotes: true, clientCreate: true };
jest.mock("@/lib/features", () => ({
  ...jest.requireActual("@/lib/features"),
  isStaffFeatureEnabled: (feature: string) => (feature === "clientNotes" ? flags.clientNotes : feature === "clientCreate" ? flags.clientCreate : true),
}));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: jest.fn() }, useFocusEffect: (effect: () => void | (() => void)) => jest.requireActual<typeof import("react")>("react").useEffect(effect, [effect]), }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EDITOR = workspace({ capabilities: { viewStudioSchedule: true, viewClients: true, markAttendance: true, editClients: true } });
const NOTE = { id: "n1", clientId: "c1", noteType: "general", body: "Call back", occurredAt: "2026-11-20T15:00:00.000Z", createdAt: "2026-11-20T15:00:01.000Z" };

beforeEach(() => {
  flags.clientNotes = true;
  flags.clientCreate = true;
  jest.clearAllMocks();
});

function renderSheet(addClientNote: jest.Mock, props: Partial<React.ComponentProps<typeof ClientNoteSheet>> = {}) {
  const onSaved = jest.fn();
  const onClose = jest.fn();
  const signOut = jest.fn(async () => undefined);
  render(
    <StaffTestProviders api={fakeApi({ addClientNote })} ws={EDITOR} signOut={signOut}>
      <ClientNoteSheet studioId={STUDIO_ID} clientId="c1" clientName="Ana Rivera" visible onClose={onClose} onSaved={onSaved} {...props} />
    </StaffTestProviders>,
  );
  return { onSaved, onClose, signOut };
}

describe("ClientNoteSheet", () => {
  it("Save is disabled until there is text; saving sends one note with a fresh noteId, an Idempotency-Key and the chosen type", async () => {
    const add = jest.fn(async () => ({ note: NOTE }));
    const { onSaved } = renderSheet(add);
    expect(screen.getByLabelText("Save note").props.accessibilityState.disabled).toBe(true);
    fireEvent.changeText(screen.getByTestId("note-body"), "  Call back Friday  ");
    fireEvent.press(screen.getByTestId("note-type-follow_up"));
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Save note"));
    });
    expect(add).toHaveBeenCalledTimes(1);
    const [studio, client, input, key] = add.mock.calls[0] as unknown as [string, string, { noteId: string; body: string; noteType: string }, string];
    expect([studio, client]).toEqual([STUDIO_ID, "c1"]);
    expect(input.body).toBe("Call back Friday");
    expect(input.noteType).toBe("follow_up");
    expect(input.noteId).toMatch(UUID);
    expect(key).toMatch(/^df-bus-/);
    expect(onSaved).toHaveBeenCalledWith(NOTE);
  });

  it("a double tap sends one request", async () => {
    const d = deferred<{ note: typeof NOTE }>();
    const add = jest.fn(() => d.promise);
    renderSheet(add);
    fireEvent.changeText(screen.getByTestId("note-body"), "x");
    fireEvent.press(screen.getByLabelText("Save note"));
    fireEvent.press(screen.getByLabelText("Save note"));
    expect(add).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve({ note: NOTE }));
  });

  it("a lost answer: Try again reuses the SAME noteId and key, and the text stays", async () => {
    const add = jest
      .fn()
      .mockRejectedValueOnce(new StaffApiError(0, "network_error", "x"))
      .mockResolvedValueOnce({ note: NOTE });
    const { onSaved } = renderSheet(add);
    fireEvent.changeText(screen.getByTestId("note-body"), "Important");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Save note"));
    });
    expect(screen.getByText("Not confirmed")).toBeTruthy();
    expect(screen.getByTestId("note-body").props.value).toBe("Important");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Try again"));
    });
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[1][2].noteId).toBe(add.mock.calls[0][2].noteId);
    expect(add.mock.calls[1][3]).toBe(add.mock.calls[0][3]);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("Discard gives up and the next note gets a NEW noteId", async () => {
    const add = jest.fn().mockRejectedValueOnce(new StaffApiError(0, "network_error", "x")).mockResolvedValueOnce({ note: NOTE });
    renderSheet(add);
    fireEvent.changeText(screen.getByTestId("note-body"), "One");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Save note"));
    });
    const firstId = add.mock.calls[0][2].noteId;
    fireEvent.press(screen.getByLabelText("Discard this change"));
    fireEvent.changeText(screen.getByTestId("note-body"), "Two");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Save note"));
    });
    expect(add.mock.calls[1][2].noteId).not.toBe(firstId);
  });

  it.each([
    ["writes_disabled", new StaffApiError(403, "writes_disabled", "off"), "This change is turned off"],
    ["upgrade_required", new StaffApiError(426, "upgrade_required", "old"), "Update DanceFlow Business"],
    ["not permitted", new StaffApiError(403, "role_not_permitted", "no"), "Not available for your role"],
  ])("%s is shown in words with no retry", async (_n, error, title) => {
    renderSheet(jest.fn(async () => Promise.reject(error)));
    fireEvent.changeText(screen.getByTestId("note-body"), "x");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Save note"));
    });
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByLabelText("Retry")).toBeNull();
    expect(screen.queryByLabelText("Try again")).toBeNull();
  });

  it("refuses a note over the length limit before sending anything", () => {
    const add = jest.fn();
    renderSheet(add);
    fireEvent.changeText(screen.getByTestId("note-body"), "x".repeat(5001));
    expect(screen.getByTestId("note-too-long")).toBeTruthy();
    expect(screen.getByLabelText("Save note").props.accessibilityState.disabled).toBe(true);
    fireEvent.press(screen.getByLabelText("Save note"));
    expect(add).not.toHaveBeenCalled();
  });

  it("does nothing at all behind a flag that is off", () => {
    flags.clientNotes = false;
    const add = jest.fn();
    renderSheet(add);
    fireEvent.changeText(screen.getByTestId("note-body"), "x");
    fireEvent.press(screen.getByLabelText("Save note"));
    expect(add).not.toHaveBeenCalled();
  });

  it("passes the static accessibility audit", () => {
    renderSheet(jest.fn());
    expect(auditA11y(screen.UNSAFE_root)).toEqual([]);
  });
});

describe("AddClientScreen", () => {
  function renderAdd(createClient: jest.Mock) {
    render(
      <StaffTestProviders api={fakeApi({ createClient })} ws={EDITOR}>
        <AddClientScreen studioId={STUDIO_ID} />
      </StaffTestProviders>,
    );
  }
  const fill = (over: Record<string, string> = {}) => {
    const v = { "client-first-name": "Ana", "client-last-name": "Rivera", "client-phone": "(555) 010-0100", "client-email": "", ...over };
    for (const [id, value] of Object.entries(v)) fireEvent.changeText(screen.getByTestId(id), value);
  };

  it("validates like the server: names, and a phone or an email, before sending", async () => {
    const create = jest.fn();
    renderAdd(create);
    fireEvent.press(screen.getByLabelText("Add client"));
    expect(screen.getByTestId("add-client-problem").props.children).toBe("Enter a first name.");
    fill({ "client-phone": "", "client-email": "" });
    fireEvent.press(screen.getByLabelText("Add client"));
    expect(screen.getByTestId("add-client-problem").props.children).toBe("Enter a phone number or an email.");
    fill({ "client-email": "not-an-email" });
    fireEvent.press(screen.getByLabelText("Add client"));
    expect(screen.getByTestId("add-client-problem").props.children).toBe("That email doesn't look right.");
    expect(create).not.toHaveBeenCalled();
    expect(validateDraft({ firstName: "A", lastName: "B", phone: "", email: "a@b.co", note: "" })).toBeNull();
  });

  it("creates the client once with a clientId and a key, then opens it", async () => {
    const create = jest.fn(async (_s: string, input: { clientId: string }) => ({ client: { id: input.clientId, firstName: "Ana", lastName: "Rivera", status: "lead" }, replayed: false }));
    renderAdd(create);
    fill();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Add client"));
    });
    expect(create).toHaveBeenCalledTimes(1);
    const [studio, input, key] = create.mock.calls[0] as unknown as [string, Record<string, unknown>, string];
    expect(studio).toBe(STUDIO_ID);
    expect(input).toMatchObject({ firstName: "Ana", lastName: "Rivera", phone: "(555) 010-0100" });
    expect(input.clientId).toMatch(UUID);
    expect(input.email).toBeUndefined();
    expect(key).toMatch(/^df-bus-/);
    expect(router.replace).toHaveBeenCalledWith({ pathname: "/clients/[id]", params: { id: input.clientId, studioId: STUDIO_ID } });
  });

  it("a lost answer retries with the same clientId and key (never a second client)", async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(new StaffApiError(0, "network_error", "x"))
      .mockImplementationOnce(async (_s: string, input: { clientId: string }) => ({ client: { id: input.clientId, firstName: "Ana", lastName: "Rivera", status: "lead" }, replayed: true }));
    renderAdd(create);
    fill();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Add client"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Try again"));
    });
    expect(create.mock.calls[1][1].clientId).toBe(create.mock.calls[0][1].clientId);
    expect(create.mock.calls[1][2]).toBe(create.mock.calls[0][2]);
  });

  it("a phone duplicate offers the existing client, adding anyway, or changing the details; adding anyway sends allowDuplicatePhone", async () => {
    const dup = new StaffApiError(409, "conflict", "dup", undefined, { serverCode: "duplicate_client", details: { existingClientId: "c9", matchedOn: "phone" } });
    const create = jest.fn().mockRejectedValueOnce(dup).mockImplementationOnce(async (_s: string, input: { clientId: string }) => ({ client: { id: input.clientId, firstName: "Ana", lastName: "Rivera", status: "lead" }, replayed: false }));
    renderAdd(create);
    fill();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Add client"));
    });
    expect(screen.getByText("This client may already exist")).toBeTruthy();
    expect(screen.getByText("A client with this phone number is already in your studio.")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Open that client"));
    expect(router.replace).toHaveBeenCalledWith({ pathname: "/clients/[id]", params: { id: "c9", studioId: STUDIO_ID } });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Add as a new client anyway"));
    });
    expect(create.mock.calls[1][1].allowDuplicatePhone).toBe(true);
  });

  it("an email duplicate cannot be overridden", async () => {
    const dup = new StaffApiError(409, "conflict", "dup", undefined, { serverCode: "duplicate_client", details: { existingClientId: "c9", matchedOn: "email" } });
    renderAdd(jest.fn().mockRejectedValueOnce(dup));
    fill({ "client-email": "ana@example.com" });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Add client"));
    });
    expect(screen.getByText("A client with this email is already in your studio.")).toBeTruthy();
    expect(screen.queryByLabelText("Add as a new client anyway")).toBeNull();
  });

  it("shows a plain message instead of the form when the flag is off", () => {
    flags.clientCreate = false;
    renderAdd(jest.fn());
    expect(screen.getByText("Not available")).toBeTruthy();
    expect(screen.queryByLabelText("Add client")).toBeNull();
  });

  it("passes the static accessibility audit", () => {
    renderAdd(jest.fn());
    expect(auditA11y(screen.UNSAFE_root)).toEqual([]);
  });
});

describe("entry points are gated by the flag AND the editClients capability", () => {
  const DETAIL: ClientDetail = { id: "c1", firstName: "Ana", lastName: "Rivera", status: "active", timeZone: "America/New_York", activePackages: [], nextAppointment: null };

  async function renderDetail(ws = EDITOR) {
    render(
      <StaffTestProviders api={fakeApi({ client: jest.fn(async () => DETAIL), clientNotes: jest.fn(async () => ({ notes: [], nextCursor: null })) })} ws={ws}>
        <ClientDetailScreen clientId="c1" studioId={STUDIO_ID} />
      </StaffTestProviders>,
    );
    await act(async () => undefined);
  }

  it("client detail: Add a note shows only with both", async () => {
    await renderDetail();
    expect(screen.getByLabelText("Add a note")).toBeTruthy();
    screen.unmount();
    flags.clientNotes = false;
    await renderDetail();
    expect(screen.queryByLabelText("Add a note")).toBeNull();
    screen.unmount();
    flags.clientNotes = true;
    await renderDetail(workspace({ capabilities: { viewStudioSchedule: true, viewClients: true, editClients: false } }));
    expect(screen.queryByLabelText("Add a note")).toBeNull();
  });

  it("clients list: Add a client shows only with both and opens the new-client screen", async () => {
    const search = jest.fn(async () => ({ clients: [], nextCursor: null }));
    render(
      <StaffTestProviders api={fakeApi({ searchClients: search })} ws={EDITOR}>
        <ClientsScreen />
      </StaffTestProviders>,
    );
    await act(async () => undefined);
    fireEvent.press(screen.getByLabelText("Add a client"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/clients/new", params: { studioId: STUDIO_ID } });
    screen.unmount();
    flags.clientCreate = false;
    render(
      <StaffTestProviders api={fakeApi({ searchClients: search })} ws={EDITOR}>
        <ClientsScreen />
      </StaffTestProviders>,
    );
    await act(async () => undefined);
    expect(screen.queryByLabelText("Add a client")).toBeNull();
  });
});

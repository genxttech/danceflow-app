import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { StaffApiError, type ClientPage } from "@/lib/staffApi";
import { ClientsScreen, SEARCH_DEBOUNCE_MS } from "@/screens/ClientsScreen";
import { deferred, fakeApi, STUDIO_ID, StaffTestProviders, workspace } from "@/test-utils/staff";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});
const mockFeatures = new Set<string>(["clients"]);
jest.mock("@/lib/features", () => ({
  ...jest.requireActual("@/lib/features"),
  isStaffFeatureEnabled: (feature: string) => mockFeatures.has(feature),
}));

const PAGE_1: ClientPage = {
  clients: [
    { id: "c1", firstName: "Ana", lastName: "Rivera", status: "active" },
    { id: "c2", firstName: "Sam", lastName: "Okafor", status: "lead" },
  ],
  nextCursor: "cursor-2",
};
const PAGE_2: ClientPage = {
  clients: [
    { id: "c2", firstName: "Sam", lastName: "Okafor", status: "lead" },
    { id: "c3", firstName: null, lastName: null, status: null },
  ],
  nextCursor: null,
};

beforeEach(() => {
  jest.useFakeTimers();
  mockFeatures.clear();
  mockFeatures.add("clients");
});
afterEach(() => jest.useRealTimers());

async function settle(ms = SEARCH_DEBOUNCE_MS) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function renderClients(api = fakeApi(), ws = workspace()) {
  render(
    <StaffTestProviders api={api} ws={ws}>
      <ClientsScreen />
    </StaffTestProviders>,
  );
  return api;
}

describe("ClientsScreen", () => {
  it("shows the placeholder while the feature is off, and calls nothing", async () => {
    mockFeatures.clear();
    const api = renderClients();
    await settle();
    expect(screen.getByTestId("clients-placeholder")).toBeTruthy();
    expect(api.searchClients).not.toHaveBeenCalled();
  });

  it("keeps instructors on My clients without studio-wide lookup", async () => {
    const api = renderClients(fakeApi(), workspace({ role: "instructor", capabilities: { viewStudioSchedule: true, viewClients: false } }));
    await settle();
    expect(screen.getByText("My clients")).toBeTruthy();
    expect(screen.getByTestId("clients-placeholder")).toBeTruthy();
    expect(api.searchClients).not.toHaveBeenCalled();
  });

  it("shows a labelled skeleton, then the first page", async () => {
    const pending = deferred<ClientPage>();
    const api = renderClients(fakeApi({ searchClients: jest.fn(() => pending.promise) }));
    await settle();
    expect(screen.getByLabelText("Loading clients")).toBeTruthy();
    expect(api.searchClients).toHaveBeenCalledWith(STUDIO_ID, { q: "" });

    await act(async () => pending.resolve(PAGE_1));
    expect(screen.getByTestId("clients-list")).toBeTruthy();
    expect(screen.getByLabelText("Ana Rivera, Active")).toBeTruthy();
    expect(screen.getByText("Lead")).toBeTruthy();
  });

  it("debounces typing into one search", async () => {
    const api = renderClients(fakeApi({ searchClients: jest.fn(async () => PAGE_1) }));
    await settle();
    api.searchClients.mockClear();

    const input = screen.getByLabelText("Search clients");
    fireEvent.changeText(input, "a");
    await settle(100);
    fireEvent.changeText(input, "an");
    await settle(100);
    fireEvent.changeText(input, "ana ");
    expect(api.searchClients).not.toHaveBeenCalled();
    await settle();

    expect(api.searchClients).toHaveBeenCalledTimes(1);
    expect(api.searchClients).toHaveBeenCalledWith(STUDIO_ID, { q: "ana" });
  });

  it("ignores a slower answer for an older query", async () => {
    const slow = deferred<ClientPage>();
    const api = renderClients(
      fakeApi({
        searchClients: jest.fn(async (_studio: string, params: { q?: string }) => {
          if (params.q === "an") return slow.promise;
          if (params.q === "ana") return { clients: [{ id: "c9", firstName: "Anabel", lastName: "Fox", status: null }], nextCursor: null };
          return PAGE_1;
        }),
      }),
    );
    await settle();
    fireEvent.changeText(screen.getByLabelText("Search clients"), "an");
    await settle();
    fireEvent.changeText(screen.getByLabelText("Search clients"), "ana");
    await settle();
    expect(screen.getByText("Anabel Fox")).toBeTruthy();

    await act(async () => slow.resolve(PAGE_1));
    expect(screen.getByText("Anabel Fox")).toBeTruthy();
    expect(screen.queryByText("Ana Rivera")).toBeNull();
    expect(api.searchClients).toHaveBeenCalledTimes(3);
  });

  it("says when nothing matches", async () => {
    renderClients(fakeApi({ searchClients: jest.fn(async () => ({ clients: [], nextCursor: null })) }));
    await settle();
    fireEvent.changeText(screen.getByLabelText("Search clients"), "zz");
    await settle();
    expect(screen.getByTestId("clients-empty")).toBeTruthy();
    expect(screen.getByText("No clients match")).toBeTruthy();
  });

  it("loads more without duplicating a row that moved pages, and labels a nameless client", async () => {
    const api = renderClients(fakeApi({ searchClients: jest.fn(async (_s: string, p: { cursor?: string | null }) => (p.cursor ? PAGE_2 : PAGE_1)) }));
    await settle();
    fireEvent.press(screen.getByRole("button", { name: "Load more clients" }));
    await settle(0);

    expect(api.searchClients).toHaveBeenLastCalledWith(STUDIO_ID, { q: "", cursor: "cursor-2" });
    expect(screen.getAllByText("Sam Okafor")).toHaveLength(1);
    expect(screen.getByText("Client")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more clients" })).toBeNull();
  });

  it("keeps the list and says so when a further page fails", async () => {
    renderClients(
      fakeApi({
        searchClients: jest.fn(async (_s: string, p: { cursor?: string | null }) => {
          if (p.cursor) throw new StaffApiError(503, "service_unavailable", "Try again.");
          return PAGE_1;
        }),
      }),
    );
    await settle();
    fireEvent.press(screen.getByRole("button", { name: "Load more clients" }));
    await settle(0);
    expect(screen.getByText("Ana Rivera")).toBeTruthy();
    expect(screen.getByText("More clients could not load. Try again.")).toBeTruthy();
  });

  it.each([
    [new StaffApiError(403, "role_not_permitted", "No."), "error-not-permitted"],
    [new StaffApiError(403, "not_a_member", "No."), "error-no-access"],
    [new StaffApiError(401, "unauthenticated", "No."), "error-sign-in-again"],
    [new StaffApiError(503, "service_unavailable", "No."), "error-unavailable"],
  ])("shows the distinct error state for %s", async (error, testID) => {
    renderClients(fakeApi({ searchClients: jest.fn(async () => Promise.reject(error)) }));
    await settle();
    expect(screen.getByTestId(testID)).toBeTruthy();
  });

  it("opens the client with its studio", async () => {
    renderClients(fakeApi({ searchClients: jest.fn(async () => PAGE_1) }));
    await settle();
    fireEvent.press(screen.getByLabelText("Ana Rivera, Active"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/clients/[id]", params: { id: "c1", studioId: STUDIO_ID } });
  });
});

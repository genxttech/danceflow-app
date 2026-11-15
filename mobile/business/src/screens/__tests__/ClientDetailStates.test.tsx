import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { StaffApiError, type ClientDetail } from "@/lib/staffApi";
import { ClientDetailScreen, packageItemLabel } from "@/screens/ClientDetailScreen";
import { fakeApi, STUDIO_ID, StaffTestProviders } from "@/test-utils/staff";

/* States of the client screen that ClientDetailScreen.test.tsx does not cover: loading, the empty and unnamed shapes, every refusal, and recovery. */

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});
jest.setTimeout(20_000);

const CLIENT: ClientDetail = {
  id: "c1",
  firstName: "Ana",
  lastName: "Rivera",
  status: "active",
  timeZone: "America/Chicago",
  activePackages: [],
  nextAppointment: null,
};

function renderClient(client: jest.Mock, props: Partial<React.ComponentProps<typeof StaffTestProviders>> = {}) {
  const api = fakeApi({ client });
  render(
    <StaffTestProviders api={api} {...props}>
      <ClientDetailScreen clientId="c1" studioId={STUDIO_ID} />
    </StaffTestProviders>,
  );
  return api;
}

describe("client screen states", () => {
  it("shows a labelled loading state first, then the client", async () => {
    let finish: (c: ClientDetail) => void = () => undefined;
    renderClient(jest.fn(() => new Promise<ClientDetail>((resolve) => (finish = resolve))));
    expect(screen.getByTestId("schedule-skeleton")).toBeTruthy();
    await act(async () => finish(CLIENT));
    expect(screen.getByText("Ana Rivera")).toBeTruthy();
  });

  it("nothing booked and no packages are sentences, not blanks", async () => {
    renderClient(jest.fn(async () => CLIENT));
    expect(await screen.findByText("Nothing booked.")).toBeTruthy();
    expect(screen.getByText("No active packages.")).toBeTruthy();
  });

  it("a client with no name on record is labelled Client, never empty", async () => {
    renderClient(jest.fn(async () => ({ ...CLIENT, firstName: "", lastName: "" })));
    expect(await screen.findByText("Client")).toBeTruthy();
  });

  it("an untracked package item says so instead of showing a number", () => {
    expect(packageItemLabel({ usageType: "private_lesson", remaining: null, unlimited: false })).toBe("Private lesson: not tracked");
    expect(packageItemLabel({ usageType: "group_class", remaining: 0, unlimited: false })).toBe("Group class: 0 remaining");
  });

  it.each([
    ["unauthenticated", 401, "error-sign-in-again"],
    ["role_not_permitted", 403, "error-not-permitted"],
    ["not_a_member", 403, "error-no-access"],
    ["workspace_paused", 403, "error-paused"],
    ["service_unavailable", 503, "error-unavailable"],
    ["not_found", 404, "error-not-found"],
  ] as const)("%s is explained", async (code, status, testID) => {
    renderClient(jest.fn(async () => Promise.reject(new StaffApiError(status, code, "x"))));
    expect(await screen.findByTestId(testID)).toBeTruthy();
  });

  it("a 401 offers Sign in again, which signs out", async () => {
    const signOut = jest.fn(async () => undefined);
    renderClient(jest.fn(async () => Promise.reject(new StaffApiError(401, "unauthenticated", "x"))), { signOut });
    fireEvent.press(await screen.findByRole("button", { name: "Sign in again" }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("an outage retries on the button and recovers", async () => {
    const client = jest.fn().mockRejectedValueOnce(new StaffApiError(503, "service_unavailable", "x")).mockResolvedValueOnce(CLIENT);
    renderClient(client);
    fireEvent.press(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Ana Rivera")).toBeTruthy();
    expect(client).toHaveBeenCalledTimes(2);
  });

  it("after a 403, Refresh studios reloads the list and then the client, with no pull needed", async () => {
    const reload = jest.fn(async () => undefined);
    const client = jest.fn().mockRejectedValueOnce(new StaffApiError(403, "role_not_permitted", "x")).mockResolvedValueOnce(CLIENT);
    renderClient(client, { reload });
    fireEvent.press(await screen.findByRole("button", { name: "Refresh studios" }));
    expect(await screen.findByText("Ana Rivera")).toBeTruthy();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(client).toHaveBeenCalledTimes(2);
  });

  it("asks for the client of the studio in the route", async () => {
    const api = renderClient(jest.fn(async () => CLIENT));
    await screen.findByText("Ana Rivera");
    expect(api.client).toHaveBeenCalledWith(STUDIO_ID, "c1");
  });
});

import { render, screen, within } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { NotificationPreferencesCard } from "@/components/NotificationPreferencesCard";
import { normalizePermissionStatus } from "@/lib/pushNotifications";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

// The real pushNotifications module is used for normalizePermissionStatus; keep its imports inert.
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("expo-constants", () => ({ __esModule: true, default: { appOwnership: null, expoConfig: { extra: { eas: { projectId: "p" } } } } }));
jest.mock("expo-notifications", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabase: {} }));

const mockState = { permissionStatus: "undetermined", message: null as string | null, pushEnabled: false };
jest.mock("@/lib/pushNotifications", () => ({
  ...jest.requireActual("@/lib/pushNotifications"),
  useNotificationPreferences: () => ({
    preferences: {
      pushEnabled: mockState.pushEnabled,
      scheduleUpdates: true,
      eventUpdates: true,
      favoriteUpdates: true,
      learningUpdates: true,
      accountUpdates: true,
      partnerUpdates: true,
    },
    permissionStatus: mockState.permissionStatus,
    loading: false,
    saving: false,
    message: mockState.message,
    updatePreferences: jest.fn(),
    setPushEnabled: jest.fn(),
    openNotificationSettings: jest.fn(),
  }),
}));

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
beforeEach(() => {
  mockState.permissionStatus = "undetermined";
  mockState.message = null;
  mockState.pushEnabled = false;
});

describe("master switch reflects this device", () => {
  it("is off until the OS permission is granted, even if the stored preference is on", () => {
    mockState.permissionStatus = "undetermined";
    mockState.pushEnabled = true;
    render(<NotificationPreferencesCard userId="u1" />);
    expect(screen.getByRole("switch", { checked: false })).toBeTruthy();
  });

  it("is on only with the preference and the permission", () => {
    mockState.permissionStatus = "granted";
    mockState.pushEnabled = true;
    render(<NotificationPreferencesCard userId="u1" />);
    expect(screen.getAllByRole("switch", { checked: true }).length).toBeGreaterThan(0);
  });
});

describe("notification permission wording", () => {
  it("is 'not asked yet' (not blocked) until the first prompt", () => {
    render(<NotificationPreferencesCard userId="u1" />);
    expect(screen.getByText("Turn on Push Notifications to allow alerts from DanceFlow.")).toBeTruthy();
    expect(screen.queryByText(/blocked in your device settings/)).toBeNull();
    expect(screen.queryByText("Open Device Settings")).toBeNull();
  });

  it("says blocked, and offers Device Settings, only once the refusal is final", () => {
    mockState.permissionStatus = "denied";
    render(<NotificationPreferencesCard userId="u1" />);
    expect(screen.getByText("Push notifications are blocked in your device settings.")).toBeTruthy();
    expect(screen.getByText("Open Device Settings")).toBeTruthy();
  });

  it("maps what the OS reports: denied-but-askable is undetermined, denied-for-good stays denied", () => {
    expect(normalizePermissionStatus({ status: "denied", canAskAgain: true })).toBe("undetermined");
    expect(normalizePermissionStatus({ status: "denied" })).toBe("undetermined");
    expect(normalizePermissionStatus({ status: "denied", canAskAgain: false })).toBe("denied");
    expect(normalizePermissionStatus({ status: "undetermined", canAskAgain: true })).toBe("undetermined");
    expect(normalizePermissionStatus({ status: "granted", canAskAgain: true })).toBe("granted");
  });
});

describe("notification card after a setup message", () => {
  it("shows the message at full width under the header, not squeezed into the title row", () => {
    const text = "Push notifications could not be set up on this device yet. Your updates still appear in the app.";
    mockState.message = text;
    render(<NotificationPreferencesCard userId="u1" />);
    expect(screen.getByText(text)).toBeTruthy();

    // The header row (the first row ancestor of the title) must not contain the message.
    let row = screen.getByText("Choose what DanceFlow sends you").parent;
    while (row && StyleSheet.flatten(row.props.style)?.flexDirection !== "row") row = row.parent;
    expect(row).toBeTruthy();
    expect(within(row as never).queryByText(text)).toBeNull();

    const style = StyleSheet.flatten(screen.getByText(text).props.style);
    expect(style.textAlign).toBeUndefined();
    expect(style.flexShrink).toBeUndefined();
  });
});

import { fireEvent, render, screen, act } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Announce } from "@/components/Announce";
import { StateMessage } from "@/components/StateMessage";
import { StaleBanner } from "@/components/StaleBanner";
import { RosterAttendance } from "@/components/RosterAttendance";
import { StaffApiError } from "@/lib/staffApi";
import { fakeApi, STUDIO_ID, StaffTestProviders } from "@/test-utils/staff";

jest.setTimeout(20_000);

describe("Announce (VoiceOver has no live regions)", () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined);
  });
  afterEach(() => spy.mockRestore());

  it("announces a message once on iOS, and again only when it changes", () => {
    const { rerender } = render(<Announce message="Saved." os="ios" />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("Saved.");
    rerender(<Announce message="Saved." os="ios" />);
    expect(spy).toHaveBeenCalledTimes(1);
    rerender(<Announce message="Not saved." os="ios" />);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("says nothing for an empty message, and nothing on Android (its live region speaks)", () => {
    render(<Announce message={null} os="ios" />);
    render(<Announce message="Something failed" os="android" />);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("what gets announced (jest runs as iOS)", () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined);
  });
  afterEach(() => spy.mockRestore());

  it("an error state announces its title and body together; a neutral state announces nothing", () => {
    render(<StateMessage tone="error" title="Sign in again" body="Your session has ended." />);
    expect(spy).toHaveBeenCalledWith("Sign in again. Your session has ended.");
    spy.mockClear();
    render(<StateMessage title="Nothing today" body="Lessons appear here." />);
    expect(spy).not.toHaveBeenCalled();
  });

  it("the stale-data banner announces what happened and when the data is from", () => {
    render(<StaleBanner loadedAt={Date.UTC(2026, 10, 9, 15, 30)} timeZone="America/New_York" onRetry={() => undefined} />);
    expect(spy).toHaveBeenCalledWith("Couldn't refresh. Showing what was loaded at 10:30 AM.");
  });

  it("a refused attendance write is announced with the dancer's name, so it is not silent on iOS", async () => {
    const setAttendance = jest.fn(async () => Promise.reject(new StaffApiError(404, "not_found", "x")));
    render(
      <StaffTestProviders api={fakeApi({ setAttendance })}>
        <RosterAttendance studioId={STUDIO_ID} appointmentId="a1" attendees={[{ clientId: "c1", name: "Ana Rivera", attendanceStatus: null }]} canMark />
      </StaffTestProviders>,
    );
    await act(async () => fireEvent.press(screen.getByRole("radio", { name: "Present, Ana Rivera" })));
    expect(spy).toHaveBeenCalledWith("Ana Rivera: Not saved. This dancer is no longer on the roster.");
  });
});

describe("wiring", () => {
  it("every alert or live-region message in the app has an Announce next to it", () => {
    const root = join(__dirname, "..", "..", "..");
    const files = ["app/sign-in.tsx", "src/components/StateMessage.tsx", "src/components/StaleBanner.tsx", "src/components/RosterAttendance.tsx", "src/screens/ClientsScreen.tsx", "src/screens/MoreScreen.tsx"];
    for (const f of files) expect(readFileSync(join(root, f), "utf8")).toContain("<Announce");
  });
});

import { guestMayView, isGuestDiscoverTab } from "@/lib/guestAccess";

describe("guest discovery access", () => {
  it.each([
    [[]],
    [["index"]],
    [["(auth)", "sign-in"]],
    [["auth", "callback"]],
    [["(tabs)", "discover"]],
    [["discover", "events"]],
    [["discover", "events", "group-classes"]],
    [["discover", "events", "social-dances"]],
    [["discover", "studios"]],
    [["studios", "[id]"]],
    [["studios", "[id]", "offerings"]],
    [["events", "[id]"]],
  ])("lets a guest view %j", (segments) => {
    expect(guestMayView(segments)).toBe(true);
  });

  it.each([
    [["(tabs)", "home"]],
    [["(tabs)", "learn"]],
    [["(tabs)", "wallet"]],
    [["(tabs)", "schedule"]],
    [["(tabs)", "more"]],
    [["(tabs)"]],
    [["wallet", "event-tickets"]],
    [["wallet", "documents", "[assignmentId]"]],
    [["events", "[id]", "register"]],
    [["events", "orders", "[orderId]"]],
    [["events", "orders"]],
    [["events"]],
    [["discover", "marketplace"]],
    [["discover", "marketplace", "[catalogItemId]"]],
    [["partners"]],
    [["partners", "[threadId]"]],
    [["jobs"]],
    [["appointments", "[id]"]],
    [["learn", "lessons", "[lessonId]"]],
    [["schedule", "request"]],
    [["profile"]],
    [["settings"]],
    [["favorites"]],
    [["lumi"]],
    [["some-new-screen"]],
  ])("keeps %j behind sign-in", (segments) => {
    expect(guestMayView(segments)).toBe(false);
  });

  it("recognises the guest Discover tab", () => {
    expect(isGuestDiscoverTab(["(tabs)", "discover"])).toBe(true);
    expect(isGuestDiscoverTab(["(tabs)", "wallet"])).toBe(false);
  });
});

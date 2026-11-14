import { routeForNotification } from "@/lib/notificationRoute";

const A = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";

describe("routeForNotification", () => {
  it("opens the named appointment or client in its studio", () => {
    expect(routeForNotification({ type: "appointment", id: A, studioId: S })).toEqual({
      pathname: "/appointments/[id]",
      params: { id: A, studioId: S },
    });
    expect(routeForNotification({ type: "client", id: A, studioId: S }).pathname).toBe("/clients/[id]");
  });

  it("falls back to Today for anything unknown or malformed", () => {
    for (const data of [
      null,
      undefined,
      "x",
      {},
      { type: "appointment", id: A },
      { type: "appointment", id: "../../etc", studioId: S },
      { type: "appointment", id: A, studioId: "not-a-uuid" },
      { type: "refund", id: A, studioId: S },
      { type: "appointment", id: 5, studioId: S },
    ]) {
      expect(routeForNotification(data)).toEqual({ pathname: "/today" });
    }
  });
});

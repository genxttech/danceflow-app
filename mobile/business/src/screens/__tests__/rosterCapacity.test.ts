import { rosterCapacityLabel } from "@/screens/AppointmentScreen";

describe("rosterCapacityLabel", () => {
  it("shows no limit, room left, full, and over capacity", () => {
    expect(rosterCapacityLabel(6, null)).toBe("6 booked");
    expect(rosterCapacityLabel(6, 10)).toBe("6 of 10 booked");
    expect(rosterCapacityLabel(10, 10)).toBe("10 of 10 booked · Full");
    expect(rosterCapacityLabel(11, 10)).toBe("11 of 10 booked · Full");
  });
});

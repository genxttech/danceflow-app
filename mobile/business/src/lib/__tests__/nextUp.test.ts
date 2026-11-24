import { dateInZone, nextUp, nextUpLabel } from "@/lib/nextUp";
import type { StudioAppointment } from "@/lib/staffApi";

const NOW = Date.parse("2026-11-24T15:00:00.000Z");
const ALL = { oneToOne: true, classes: true };

const appt = (id: string, startsAt: string, endsAt: string, over: Partial<StudioAppointment> = {}): StudioAppointment => ({
  id,
  title: null,
  appointmentType: "private_lesson",
  status: "scheduled",
  startsAt,
  endsAt,
  room: null,
  locationName: null,
  client: { id: "c1", firstName: "Ana", lastName: "Rivera" },
  partner: null,
  instructor: null,
  ...over,
});

describe("nextUp", () => {
  it("picks the earliest open lesson that has not ended, in progress included", () => {
    const result = nextUp(
      [
        appt("later", "2026-11-24T17:00:00.000Z", "2026-11-24T17:45:00.000Z"),
        appt("now", "2026-11-24T14:30:00.000Z", "2026-11-24T15:15:00.000Z"),
        appt("done", "2026-11-24T12:00:00.000Z", "2026-11-24T12:45:00.000Z", { status: "attended" }),
      ],
      NOW,
      ALL,
    );
    expect(result).toMatchObject({ kind: "check_in", behind: 0 });
    expect(result?.appointment.id).toBe("now");
  });

  it("offers attendance for a class and a check-in for a lesson", () => {
    expect(nextUp([appt("c", "2026-11-24T16:00:00.000Z", "2026-11-24T17:00:00.000Z", { appointmentType: "group_class" })], NOW, ALL)?.kind).toBe("take_attendance");
    expect(nextUp([appt("l", "2026-11-24T16:00:00.000Z", "2026-11-24T16:45:00.000Z", { appointmentType: "coaching" })], NOW, ALL)?.kind).toBe("check_in");
  });

  it("counts earlier open ones as behind, and targets the oldest when nothing is ahead", () => {
    const earlier = [appt("e1", "2026-11-24T10:00:00.000Z", "2026-11-24T10:45:00.000Z"), appt("e2", "2026-11-24T11:00:00.000Z", "2026-11-24T11:45:00.000Z")];
    const ahead = nextUp([...earlier, appt("next", "2026-11-24T16:00:00.000Z", "2026-11-24T16:45:00.000Z")], NOW, ALL);
    expect(ahead).toMatchObject({ kind: "check_in", behind: 2 });
    expect(ahead?.appointment.id).toBe("next");
    const onlyBehind = nextUp(earlier, NOW, ALL);
    expect(onlyBehind).toMatchObject({ kind: "record_result", behind: 1 });
    expect(onlyBehind?.appointment.id).toBe("e1");
  });

  it("ignores finished, cancelled, no-show, rentals and other types", () => {
    const rows = [
      appt("a", "2026-11-24T16:00:00.000Z", "2026-11-24T16:45:00.000Z", { status: "attended" }),
      appt("b", "2026-11-24T16:00:00.000Z", "2026-11-24T16:45:00.000Z", { status: "cancelled" }),
      appt("c", "2026-11-24T16:00:00.000Z", "2026-11-24T16:45:00.000Z", { status: "no_show" }),
      appt("d", "2026-11-24T16:00:00.000Z", "2026-11-24T16:45:00.000Z", { appointmentType: "floor_space_rental" }),
      appt("e", "2026-11-24T16:00:00.000Z", "2026-11-24T16:45:00.000Z", { appointmentType: "practice_party" }),
    ];
    expect(nextUp(rows, NOW, ALL)).toBeNull();
    expect(nextUp([], NOW, ALL)).toBeNull();
  });

  it("offers a kind only when its capability is on in this build", () => {
    const rows = [
      appt("l", "2026-11-24T16:00:00.000Z", "2026-11-24T16:45:00.000Z"),
      appt("c", "2026-11-24T17:00:00.000Z", "2026-11-24T18:00:00.000Z", { appointmentType: "group_class" }),
    ];
    expect(nextUp(rows, NOW, { oneToOne: false, classes: true })?.appointment.id).toBe("c");
    expect(nextUp(rows, NOW, { oneToOne: true, classes: false })?.appointment.id).toBe("l");
    expect(nextUp(rows, NOW, { oneToOne: false, classes: false })).toBeNull();
  });

  it("a lesson ending exactly now has ended; an unreadable end time falls back to the start", () => {
    const boundary = nextUp([appt("x", "2026-11-24T14:00:00.000Z", "2026-11-24T15:00:00.000Z")], NOW, ALL);
    expect(boundary?.kind).toBe("record_result");
    const unreadable = nextUp([appt("y", "2026-11-24T10:00:00.000Z", "not a time")], NOW, ALL);
    expect(unreadable?.kind).toBe("record_result");
  });

  it("dateInZone gives the studio's calendar date", () => {
    expect(dateInZone(Date.parse("2026-11-25T03:30:00.000Z"), "America/New_York")).toBe("2026-11-24");
    expect(dateInZone(Date.parse("2026-11-25T03:30:00.000Z"), "Not/AZone")).toBeNull();
  });

  it("breaks ties by id so the pick is stable", () => {
    const rows = [appt("b", "2026-11-24T16:00:00.000Z", "2026-11-24T16:45:00.000Z"), appt("a", "2026-11-24T16:00:00.000Z", "2026-11-24T16:45:00.000Z")];
    expect(nextUp(rows, NOW, ALL)?.appointment.id).toBe("a");
  });

  it("labels in plain words", () => {
    expect(nextUpLabel("check_in", "Ana Rivera")).toBe("Check in Ana Rivera");
    expect(nextUpLabel("take_attendance", "Salsa")).toBe("Take attendance");
    expect(nextUpLabel("record_result", "Ana Rivera")).toBe("Record the result for Ana Rivera");
  });
});

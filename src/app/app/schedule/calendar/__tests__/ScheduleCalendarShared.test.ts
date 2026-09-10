import { describe, expect, it } from "vitest";
import { clientName, itemDisplayTitle, type CalendarItem } from "../ScheduleCalendarShared";

/**
 * GC-1.3A: a shared group_class appointment has no single client_id --
 * clientName()'s "Unassigned client" fallback (correct for a genuinely
 * unassigned lesson) was being used as the calendar card TITLE for a class,
 * rendering "Unassigned client" instead of the class name/type. This proves
 * itemDisplayTitle falls back to the class's own title/type label, and that
 * lesson title behavior (client name as title) is unchanged.
 */

function baseAppointment(overrides: Partial<CalendarItem>): CalendarItem {
  return {
    kind: "appointment",
    id: "appt-1",
    appointment_type: "private_lesson",
    status: "scheduled",
    starts_at: "2026-09-10T10:00:00.000Z",
    ends_at: "2026-09-10T11:00:00.000Z",
    clients: null,
    ...overrides,
  };
}

describe("itemDisplayTitle", () => {
  it("a group_class with no client_id shows its title, not 'Unassigned client'", () => {
    const item = baseAppointment({
      appointment_type: "group_class",
      title: "Bronze Foxtrot",
      clients: null,
    });

    expect(itemDisplayTitle(item)).toBe("Bronze Foxtrot");
    expect(itemDisplayTitle(item)).not.toBe("Unassigned client");
  });

  it("a group_class with no client_id and no title falls back to the type label, not 'Unassigned client'", () => {
    const item = baseAppointment({
      appointment_type: "group_class",
      title: null,
      clients: null,
    });

    expect(itemDisplayTitle(item)).toBe("Group class");
    expect(itemDisplayTitle(item)).not.toBe("Unassigned client");
  });

  it("a lesson's title behavior is unchanged: shows the client's name", () => {
    const item = baseAppointment({
      appointment_type: "private_lesson",
      title: "Should not be used as title",
      clients: { first_name: "Ada", last_name: "Lovelace" },
    });

    expect(itemDisplayTitle(item)).toBe(clientName(item));
    expect(itemDisplayTitle(item)).toBe("Ada Lovelace");
  });

  it("an event's title behavior is unchanged", () => {
    const item: CalendarItem = {
      kind: "event",
      id: "event-1",
      status: "published",
      starts_at: "2026-09-10T10:00:00.000Z",
      ends_at: "2026-09-10T11:00:00.000Z",
      title: "Fall Showcase",
    };

    expect(itemDisplayTitle(item)).toBe("Fall Showcase");
  });

  it("clientName() itself is unchanged (still returns 'Unassigned client' for a clientless appointment)", () => {
    const item = baseAppointment({ appointment_type: "group_class", clients: null });
    expect(clientName(item)).toBe("Unassigned client");
  });
});

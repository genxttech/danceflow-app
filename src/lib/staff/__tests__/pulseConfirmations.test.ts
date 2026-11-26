import { describe, expect, it, vi } from "vitest";
import { FakeQuery } from "@/app/api/staff/__tests__/staffApiWorld";
import { loadPulseCards, type ConfirmationsCard } from "@/lib/staff/pulseCards";
import { CONFIRMATION_WINDOW_HOURS, confirmationWindow } from "@/lib/staff/pulseConfirmations";

/*
  Pulse "not confirmed yet" card: appointments of one dancer that are still scheduled or rescheduled and start within 48 elapsed hours. Boundaries, statuses,
  tenancy and the role matrix (broad roles studio-wide with names; an instructor only their own, without names; everyone else nothing).
*/

const STUDIO = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const INSTRUCTOR = "11111111-0000-4000-8000-000000000001";
const COLLEAGUE = "11111111-0000-4000-8000-000000000002";
const USER = "99999999-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-22T15:00:00.000Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

type Row = Record<string, unknown>;

const appointment = (id: string, offsetMs: number, over: Row = {}): Row => ({
  id,
  studio_id: STUDIO,
  client_id: "c1",
  instructor_id: INSTRUCTOR,
  appointment_type: "private_lesson",
  status: "scheduled",
  starts_at: at(offsetMs),
  ...over,
});

const clients: Row[] = [
  { id: "c1", studio_id: STUDIO, first_name: "Maya", last_name: "Chen" },
  { id: "c2", studio_id: STUDIO, first_name: "Evan", last_name: "Hale" },
  { id: "cB", studio_id: OTHER, first_name: "Bea", last_name: "Elsewhere" },
];

function world(appointments: Row[], options: { instructorOf?: string | null; failAppointments?: boolean } = {}) {
  const reads: string[] = [];
  const supabase = {
    from(table: string) {
      reads.push(table);
      if (table === "instructors") {
        return new FakeQuery(options.instructorOf ? [{ id: options.instructorOf, user_id: USER, studio_id: STUDIO, active: true }] : [], null);
      }
      if (table === "appointments") return new FakeQuery(appointments, options.failAppointments ? { message: "row text that must never be logged" } : null);
      if (table === "clients") return new FakeQuery(clients, null);
      return new FakeQuery([], null);
    },
  };
  return { supabase: supabase as never, reads };
}

async function cardFor(role: string, appointments: Row[], options: Parameters<typeof world>[1] = {}) {
  const w = world(appointments, options);
  const cards = await loadPulseCards({ supabase: w.supabase, studioId: STUDIO, userId: USER, studioRole: role, now: NOW, today: { total: 0, upcoming: 0, cancelled: 0, truncated: false } });
  return { card: cards.confirmations as ConfirmationsCard | null | { state: "unavailable" }, reads: w.reads };
}

const ids = (card: unknown) => (card as ConfirmationsCard).upcoming.map((item) => item.id);

describe("the 48-hour window", () => {
  it("is 48 elapsed hours from now, also across a daylight saving change", () => {
    expect(CONFIRMATION_WINDOW_HOURS).toBe(48);
    expect(confirmationWindow(new Date("2026-10-31T05:30:00.000Z"))).toEqual({ after: "2026-10-31T05:30:00.000Z", until: "2026-11-02T05:30:00.000Z" });
  });

  it("includes a start one millisecond from now and exactly 48 hours out; excludes now, the past and 48 hours plus one millisecond", async () => {
    const { card } = await cardFor("studio_owner", [
      appointment("past", -HOUR),
      appointment("now", 0),
      appointment("soonest", 1),
      appointment("limit", 48 * HOUR),
      appointment("beyond", 48 * HOUR + 1),
    ]);
    expect(card).toMatchObject({ state: "ok", windowHours: 48, total: 2, truncated: false });
    expect(ids(card)).toEqual(["soonest", "limit"]);
  });
});

describe("which appointments wait for a confirmation", () => {
  it("scheduled and rescheduled only", async () => {
    const statuses = ["scheduled", "rescheduled", "confirmed", "cancelled", "attended", "no_show"];
    const { card } = await cardFor("studio_owner", statuses.map((status, index) => appointment(status, (index + 1) * HOUR, { status })));
    expect(ids(card)).toEqual(["scheduled", "rescheduled"]);
  });

  it("needs one dancer and is not a floor space rental", async () => {
    const { card } = await cardFor("studio_owner", [
      appointment("class", HOUR, { client_id: null, appointment_type: "group_class" }),
      appointment("rental", 2 * HOUR, { appointment_type: "floor_space_rental" }),
      appointment("intro", 3 * HOUR, { appointment_type: "intro_lesson" }),
    ]);
    expect(ids(card)).toEqual(["intro"]);
  });

  it("lists the soonest five with the exact total", async () => {
    const many = Array.from({ length: 8 }, (_, index) => appointment(`a${index}`, (8 - index) * HOUR));
    const { card } = await cardFor("studio_owner", many);
    expect(card).toMatchObject({ total: 8, truncated: true });
    expect(ids(card)).toEqual(["a7", "a6", "a5", "a4", "a3"]);
  });

  it("nothing waiting is an ok card with zero", async () => {
    const { card } = await cardFor("studio_owner", []);
    expect(card).toMatchObject({ state: "ok", total: 0, truncated: false, upcoming: [] });
  });
});

describe("tenancy and roles", () => {
  const rows = [
    appointment("mine", HOUR),
    appointment("colleague", 2 * HOUR, { instructor_id: COLLEAGUE, client_id: "c2" }),
    appointment("unassigned", 3 * HOUR, { instructor_id: null, client_id: "c2" }),
    appointment("elsewhere", HOUR, { studio_id: OTHER, client_id: "cB" }),
  ];

  it.each(["studio_owner", "studio_admin", "front_desk"])("%s sees the studio's appointments with names, never another studio's", async (role) => {
    const { card } = await cardFor(role, rows);
    expect(card).toMatchObject({ state: "ok", total: 3, cardId: "missing_confirmations", cardType: "missing_confirmations", actions: [] });
    expect(ids(card)).toEqual(["mine", "colleague", "unassigned"]);
    expect((card as ConfirmationsCard).upcoming.map((item) => item.clientName)).toEqual(["Maya Chen", "Evan Hale", "Evan Hale"]);
    expect(JSON.stringify(card)).not.toMatch(/elsewhere|Elsewhere/);
  });

  it("an instructor sees only their own appointments, with no client name and no client read", async () => {
    const { card, reads } = await cardFor("instructor", rows, { instructorOf: INSTRUCTOR });
    expect(card).toMatchObject({ state: "ok", total: 1 });
    expect(ids(card)).toEqual(["mine"]);
    expect((card as ConfirmationsCard).upcoming[0].clientName).toBeNull();
    expect(JSON.stringify(card)).not.toMatch(/Maya|Evan/);
    expect(reads).not.toContain("clients");
  });

  it("an instructor with no linked instructor record gets zero, never the studio's, and no appointment is read", async () => {
    const { card, reads } = await cardFor("instructor", rows, { instructorOf: null });
    expect(card).toMatchObject({ state: "ok", total: 0, upcoming: [] });
    expect(reads).not.toContain("appointments");
  });

  it.each(["independent_instructor", "platform_admin", "organizer_owner", "a_future_role"])("%s gets no card and nothing is read", async (role) => {
    const { card, reads } = await cardFor(role, rows);
    expect(card).toBeNull();
    expect(reads).toEqual([]);
  });

  it("a failed lookup makes only this card unavailable and logs no row text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { card } = await cardFor("studio_owner", rows, { failAppointments: true });
    expect(card).toEqual({ state: "unavailable" });
    expect(spy.mock.calls.flat().join(" ")).not.toContain("row text that must never be logged");
    spy.mockRestore();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeCursor, decodeCursor } from "@/lib/staff/clients";
import { createAdminWorldClient, createWorldClient, type AuthOutcome } from "./staffApiWorld";

/*
  Independent-review hardening of the staff API (2026-11-19):
    S1  a failed name lookup after the attendance write must not turn the committed write into a 503
    S3  a mobile status change must not erase notes written on the web
    N   a hand-made clients cursor is a 400, never a failing query
*/

const harness = vi.hoisted(() => ({
  rosterNamesFail: false,
  upsertCalls: [] as Record<string, unknown>[],
  written: false,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: { global: { headers: { Authorization: string } } }) =>
    createWorldClient(options.global.headers.Authorization.replace(/^Bearer /, ""), {
      failures: {},
      authFailure: null as unknown as AuthOutcome,
    }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createAdminWorldClient() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("no cookie client");
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => {
    throw new Error("no cookies");
  },
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("no redirect");
  },
}));

vi.mock("@/lib/auth/appointmentAccess", () => ({
  requireAppointmentRelationshipAccess: async () => ({
    ok: true,
    scope: "own-instructor",
    appointment: { id: "a1", studio_id: "s1", client_id: null, instructor_id: "i1", appointment_type: "group_class", status: "scheduled" },
  }),
}));
vi.mock("@/lib/schedule/groupClassRosterPanel", () => ({
  loadInstructorRosterNames: async () => {
    if (harness.rosterNamesFail) throw new Error("Could not find the function public.get_class_roster_names_for_instructor");
    return new Map();
  },
}));
vi.mock("@/lib/schedule/classAttendance", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/schedule/classAttendance")>();
  return {
    ...real,
    upsertAttendanceRecord: async (p: Record<string, unknown>) => {
      harness.upsertCalls.push(p);
      harness.written = true;
    },
  };
});

const { markClassAttendance } = await import("@/lib/staff/classAttendance");
const realClassAttendance = await vi.importActual<typeof import("@/lib/schedule/classAttendance")>("@/lib/schedule/classAttendance");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  harness.rosterNamesFail = false;
  harness.upsertCalls = [];
  harness.written = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** Answers the reads markClassAttendance makes: the enrollment, then the attendance row (absent until the mocked write has run). */
function attendanceClient() {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, { select: chain, eq: chain });
      q.maybeSingle = async () => {
        if (table === "appointment_attendees") return { data: { id: "e1" }, error: null };
        if (table === "attendance_records") {
          return { data: harness.written ? { status: "attended", updated_at: "2026-11-19T10:00:00Z" } : null, error: null };
        }
        return { data: null, error: null };
      };
      return q;
    },
  };
}

const markArgs = { studioId: "s1", studioRole: "instructor", userId: "u1", appointmentId: "a1", clientId: "c1", status: "attended" as const };

describe("S1: attendance write is not undone by a failed name lookup", () => {
  it("returns ok with displayName null when the roster-names function is missing, after the write ran", async () => {
    harness.rosterNamesFail = true;
    const result = await markClassAttendance({ supabase: attendanceClient() as never, ...markArgs });
    expect(harness.upsertCalls).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, attendee: { clientId: "c1", displayName: null, status: "attended" } });
  });
});

describe("S3: notes survive a status change", () => {
  const recording = () => {
    const calls: { op: string; payload: Record<string, unknown> }[] = [];
    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "r1" }, error: null }) }) }) }),
        update: (payload: Record<string, unknown>) => {
          calls.push({ op: "update", payload });
          return { eq: async () => ({ error: null }) };
        },
        insert: async (payload: Record<string, unknown>) => {
          calls.push({ op: "insert", payload });
          return { error: null };
        },
      }),
    };
    return { client, calls };
  };
  const base = { studioId: "s1", appointmentId: "a1", clientId: "c1", createdBy: "u1", status: "attended" as const, checkedInAt: "t", markedAttendedAt: "t" };

  it("the default update still writes notes null (the web actions keep their behaviour)", async () => {
    const { client, calls } = recording();
    await realClassAttendance.upsertAttendanceRecord({ supabase: client as never, ...base });
    expect(calls[0].payload).toHaveProperty("notes", null);
  });
  it("preserveNotes omits notes from the update", async () => {
    const { client, calls } = recording();
    await realClassAttendance.upsertAttendanceRecord({ supabase: client as never, ...base, preserveNotes: true });
    expect(calls[0].payload).not.toHaveProperty("notes");
    expect(calls[0].payload).toMatchObject({ status: "attended", checked_in_at: "t", marked_attended_at: "t" });
  });
  it("preserveNotes with notes passed writes them", async () => {
    const { client, calls } = recording();
    await realClassAttendance.upsertAttendanceRecord({ supabase: client as never, ...base, preserveNotes: true, notes: "x" });
    expect(calls[0].payload).toHaveProperty("notes", "x");
  });
  it("the staff attendance mark asks for preserveNotes", async () => {
    await markClassAttendance({ supabase: attendanceClient() as never, ...markArgs });
    expect(harness.upsertCalls[0]).toMatchObject({ preserveNotes: true });
  });
});

describe("N: clients cursor", () => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const id = "0b9f7a3e-1d2c-4b5a-8e6f-7a8b9c0d1e2f";
  it("accepts what encodeCursor makes", () => {
    expect(decodeCursor(encodeCursor({ lastName: "Lee", firstName: "Ann", id }))).toEqual({ l: "Lee", f: "Ann", i: id });
  });
  it.each([
    ["not a uuid", { l: "a", f: "b", i: 'x",id.eq.1' }],
    ["short id", { l: "a", f: "b", i: "123" }],
    ["long last name", { l: "a".repeat(201), f: "b", i: id }],
    ["long first name", { l: "a", f: "b".repeat(201), i: id }],
    ["missing field", { l: "a", i: id }],
  ])("rejects %s", (_n, o) => {
    expect(decodeCursor(enc(o))).toBe("invalid");
  });
});

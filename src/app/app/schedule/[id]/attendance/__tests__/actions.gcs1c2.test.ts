import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GC-S1C-2: the database guard refuses attended / no_show against a cancelled
 * class (GCSC2_CLASS_CANCELLED). The staff attendance actions must turn that
 * into fixed owner-facing copy and never expose the database text; every other
 * failure keeps its existing generic code.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
const getCurrentStudioContextMock = vi.fn();
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...a: unknown[]) => getCurrentStudioContextMock(...a),
}));
const relationshipMock = vi.fn();
vi.mock("@/lib/auth/appointmentAccess", () => ({
  requireAppointmentRelationshipAccess: (...a: unknown[]) => relationshipMock(...a),
}));

let writeError: { message: string } | null = null;
function chain() {
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.eq = () => c;
  c.maybeSingle = () => Promise.resolve({ data: null, error: null });
  c.insert = () => Promise.resolve({ data: null, error: writeError });
  c.update = () => c;
  return c;
}
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => chain() }),
}));

const actions = await import("../actions");

const fd = () => {
  const f = new FormData();
  f.set("appointmentId", "appt-1");
  f.set("clientId", "client-1");
  return f;
};
const redirectUrl = (e: unknown) => ((e as { digest?: string }).digest ?? "").split(";")[2] ?? "";
const run = (p: Promise<unknown>) => p.catch((e) => e);

beforeEach(() => {
  writeError = null;
  getCurrentStudioContextMock.mockResolvedValue({ studioId: "studio-1", studioRole: "studio_owner", isPlatformAdmin: false, userId: "u1", email: "x@y.com" });
  relationshipMock.mockResolvedValue({
    ok: true,
    scope: "broad",
    appointment: { id: "appt-1", studio_id: "studio-1", appointment_type: "group_class", title: "x" },
  });
});

describe("S1C-2 attendance actions on a cancelled class", () => {
  const cancelled = { message: "GCSC2_CLASS_CANCELLED: This class has been cancelled and attendance can no longer be recorded." };

  it("attended and no-show map the guard refusal to the fixed code, with no database text", async () => {
    for (const action of [actions.markClassAttendedAction, actions.markClassNoShowAction]) {
      writeError = cancelled;
      const url = redirectUrl(await run(action(fd())));
      expect(url).toContain("error=attendance_class_cancelled");
      expect(url).not.toContain("GCSC2");
      expect(url).not.toContain("cancelled%20and");
    }
  });

  it("other failures keep their existing generic codes", async () => {
    writeError = { message: "some other database failure" };
    expect(redirectUrl(await run(actions.markClassAttendedAction(fd())))).toContain("error=attended_failed");
    expect(redirectUrl(await run(actions.markClassNoShowAction(fd())))).toContain("error=no_show_failed");
  });

  it("check-in keeps its own behavior (the guard only governs terminal outcomes)", async () => {
    writeError = { message: "anything" };
    expect(redirectUrl(await run(actions.checkInClassAttendeeAction(fd())))).toContain("error=checkin_failed");
  });

  it("the attendance page shows the safe copy for the new code", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("src/app/app/schedule/[id]/attendance/page.tsx", "utf8");
    expect(page).toContain("attendance_class_cancelled");
    expect(page).toContain("This class has been cancelled and attendance can no longer be recorded.");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  INSTRUCTOR_NOT_ASSIGNABLE_MESSAGE,
  assignmentRelationshipChanged,
  isInstructionalAppointmentType,
  validateAssignableInstructor,
} from "@/lib/instructors/assignability";

/**
 * Landmark 1A Slice 5 -- unit coverage for the shared assignability
 * validator. Mocks only the Supabase query builder chain used by
 * validateAssignableInstructor (a single .from().select()...maybeSingle()
 * call) -- no server action or RPC transport involved.
 */

function buildMockSupabase(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const not = vi.fn().mockReturnValue({ maybeSingle });
  const eqCan = vi.fn().mockReturnValue({ not });
  const eqActive = vi.fn().mockReturnValue({ eq: eqCan });
  const eqStudio = vi.fn().mockReturnValue({ eq: eqActive });
  const eqId = vi.fn().mockReturnValue({ eq: eqStudio });
  const select = vi.fn().mockReturnValue({ eq: eqId });
  const from = vi.fn().mockReturnValue({ select });
  return { from } as unknown as Parameters<typeof validateAssignableInstructor>[0];
}

describe("validateAssignableInstructor", () => {
  it("returns null (valid) for a null instructorId without querying", async () => {
    const from = vi.fn();
    const supabase = { from } as unknown as Parameters<typeof validateAssignableInstructor>[0];
    const result = await validateAssignableInstructor(supabase, "studio-1", null);
    expect(result).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("returns null when a matching eligible instructor row exists", async () => {
    const supabase = buildMockSupabase({ data: { id: "instructor-1" }, error: null });
    const result = await validateAssignableInstructor(supabase, "studio-1", "instructor-1");
    expect(result).toBeNull();
  });

  it("returns the generic message when no matching row exists (any reason)", async () => {
    const supabase = buildMockSupabase({ data: null, error: null });
    const result = await validateAssignableInstructor(supabase, "studio-1", "instructor-1");
    expect(result).toBe(INSTRUCTOR_NOT_ASSIGNABLE_MESSAGE);
  });

  it("throws on an unexpected DB error rather than returning a validation message", async () => {
    const supabase = buildMockSupabase({ data: null, error: { message: "connection reset" } });
    await expect(
      validateAssignableInstructor(supabase, "studio-1", "instructor-1"),
    ).rejects.toThrow("connection reset");
  });

  it("queries studio_id, active, can_instruct, and user_id-not-null together", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: "i1" }, error: null });
    const not = vi.fn().mockReturnValue({ maybeSingle });
    const eqCan = vi.fn().mockReturnValue({ not });
    const eqActive = vi.fn().mockReturnValue({ eq: eqCan });
    const eqStudio = vi.fn().mockReturnValue({ eq: eqActive });
    const eqId = vi.fn().mockReturnValue({ eq: eqStudio });
    const select = vi.fn().mockReturnValue({ eq: eqId });
    const from = vi.fn().mockReturnValue({ select });
    const supabase = { from } as unknown as Parameters<typeof validateAssignableInstructor>[0];

    await validateAssignableInstructor(supabase, "studio-1", "instructor-1");

    expect(from).toHaveBeenCalledWith("instructors");
    expect(select).toHaveBeenCalledWith("id");
    expect(eqId).toHaveBeenCalledWith("id", "instructor-1");
    expect(eqStudio).toHaveBeenCalledWith("studio_id", "studio-1");
    expect(eqActive).toHaveBeenCalledWith("active", true);
    expect(eqCan).toHaveBeenCalledWith("can_instruct", true);
    expect(not).toHaveBeenCalledWith("user_id", "is", null);
  });
});

describe("isInstructionalAppointmentType", () => {
  it("accepts every genuinely instructional type", () => {
    for (const type of [
      "private_lesson",
      "group_class",
      "intro_lesson",
      "coaching",
      "practice_party",
      "event",
    ]) {
      expect(isInstructionalAppointmentType(type)).toBe(true);
    }
  });

  it("excludes floor_space_rental and room_unavailable", () => {
    expect(isInstructionalAppointmentType("floor_space_rental")).toBe(false);
    expect(isInstructionalAppointmentType("room_unavailable")).toBe(false);
  });
});

describe("assignmentRelationshipChanged", () => {
  const base = {
    previousInstructorId: "instructor-1",
    previousStudioId: "studio-1",
    previousAppointmentType: "private_lesson",
    nextInstructorId: "instructor-1",
    nextStudioId: "studio-1",
    nextAppointmentType: "private_lesson",
  };

  it("is false when nothing relevant changed", () => {
    expect(assignmentRelationshipChanged(base)).toBe(false);
  });

  it("is true when instructor_id changes", () => {
    expect(
      assignmentRelationshipChanged({ ...base, nextInstructorId: "instructor-2" }),
    ).toBe(true);
  });

  it("is true when studio_id changes, even with the same instructor_id", () => {
    expect(
      assignmentRelationshipChanged({ ...base, nextStudioId: "studio-2" }),
    ).toBe(true);
  });

  it("is true when appointment_type changes, even with the same instructor_id and studio_id", () => {
    expect(
      assignmentRelationshipChanged({ ...base, nextAppointmentType: "coaching" }),
    ).toBe(true);
  });
});

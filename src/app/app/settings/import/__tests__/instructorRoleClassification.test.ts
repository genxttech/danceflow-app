import { describe, expect, it } from "vitest";
import {
  isBlockingErrorCode,
  isDeterministicallyInstructionalSourceRole,
} from "@/app/app/settings/import/classification";

/**
 * Landmark 1A Slice 5 -- CSV import integrity fix. Confirms
 * staff_role_requires_review is now a blocking code (a non-instructional
 * or ambiguous source role skips the row entirely, rather than silently
 * creating an inert-but-present instructors roster record), and that the
 * underlying role classification behaves per the approved design: an
 * explicit instructor/teacher/coach role is instructional; a clearly
 * non-instructional role (front desk, studio manager) is not; a role with
 * no signal at all is handled by the caller (validateInstructorImportBatchAction
 * only runs this classification when sourceRole is non-empty), not by
 * this function returning some third "ambiguous" value -- anything that
 * isn't a positive match is treated as review-required, matching a
 * single-bucket, conservative design.
 */

describe("isBlockingErrorCode", () => {
  it("treats staff_role_requires_review as blocking", () => {
    expect(isBlockingErrorCode("staff_role_requires_review")).toBe(true);
  });

  it("still treats every pre-existing blocking code as blocking", () => {
    for (const code of [
      "missing_required_field",
      "invalid_email",
      "duplicate_in_file",
      "ambiguous_existing_match",
      "duplicate_source_identity",
      "missing_header",
      "invalid_datetime",
      "missing_related_record",
      "invalid_amount",
      "execution_failed",
    ]) {
      expect(isBlockingErrorCode(code)).toBe(true);
    }
  });

  it("still treats possible_existing_match as non-blocking (a warning, not an error)", () => {
    expect(isBlockingErrorCode("possible_existing_match")).toBe(false);
  });
});

describe("isDeterministicallyInstructionalSourceRole", () => {
  it("accepts explicit instructor/teacher/coach roles", () => {
    expect(isDeterministicallyInstructionalSourceRole("Instructor")).toBe(true);
    expect(isDeterministicallyInstructionalSourceRole("Dance Teacher")).toBe(true);
    expect(isDeterministicallyInstructionalSourceRole("Head Coach")).toBe(true);
    expect(isDeterministicallyInstructionalSourceRole("instructor")).toBe(true);
  });

  it("rejects clearly non-instructional roles (front desk / studio manager)", () => {
    expect(isDeterministicallyInstructionalSourceRole("Front Desk")).toBe(false);
    expect(isDeterministicallyInstructionalSourceRole("Studio Manager")).toBe(false);
    expect(isDeterministicallyInstructionalSourceRole("Sales Associate")).toBe(false);
  });

  it("rejects an ambiguous/unrecognized role the same way as a clearly non-instructional one", () => {
    expect(isDeterministicallyInstructionalSourceRole("Assistant")).toBe(false);
    expect(isDeterministicallyInstructionalSourceRole("Staff")).toBe(false);
  });
});

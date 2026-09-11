import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GC-1.4A: group classes were never intended to go through the
 * private-lesson self-service exclusive-slot booking flow. Confirmed
 * (research, both planning rounds) to be real but zero-live-usage --
 * removed from all seven locations: three API-route LESSON_TYPES arrays,
 * two student/staff UI surfaces, two staff availability-config surfaces.
 *
 * These are structural regression tests, not behavioral route tests (the
 * route handlers require a much heavier auth/admin-client mock to exercise
 * directly) -- each asserts the literal string "group_class" no longer
 * appears in the specific file it was removed from, so a future re-add is
 * caught immediately rather than silently reintroducing the removed
 * self-service surface.
 */

const REPO_ROOT = join(__dirname, "../../../../../..");

const REMOVED_FROM: string[] = [
  "src/app/api/student/self-service/requests/route.ts",
  "src/app/api/student/self-service/actions/route.ts",
  "src/app/api/student/self-service/slots/route.ts",
  "src/app/app/settings/SettingsForm.tsx",
  "src/app/portal/[studioSlug]/schedule/SelfServiceBookingPanel.tsx",
  "src/app/app/schedule/self-service/availability/page.tsx",
  "src/app/app/schedule/self-service/availability/actions.ts",
  "src/app/app/instructors/[id]/availability/InstructorAvailabilityEditor.tsx",
  "src/app/app/instructors/[id]/availability/actions.ts",
];

describe("GC-1.4A self-service group_class removal", () => {
  it.each(REMOVED_FROM)("does not reference group_class: %s", (relativePath) => {
    const contents = readFileSync(join(REPO_ROOT, relativePath), "utf-8");
    expect(contents).not.toMatch(/group_class/);
  });
});

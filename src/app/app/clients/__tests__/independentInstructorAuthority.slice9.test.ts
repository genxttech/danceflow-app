import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Landmark 1A Slice 9: the renter/independent-instructor settings write must
 * have exactly one guarded implementation, and the hybrid-promotion form must
 * only be shown to viewers who hold the RPC's authority. Source-level checks
 * (the page and action modules pull in the whole app, so they are not
 * imported here).
 */
const clientsDir = join(process.cwd(), "src", "app", "app", "clients");
const read = (...parts: string[]) => readFileSync(join(clientsDir, ...parts), "utf8");

describe("independent-instructor authority (Slice 9)", () => {
  it("removes the unguarded duplicate settings action from the clients actions module", () => {
    expect(read("actions.ts")).not.toContain("updateIndependentInstructorSettingsAction");
  });

  it("keeps the single canonical, edit-access-guarded action and its only importer", () => {
    const canonical = read("[id]", "actions.ts");
    expect(canonical).toContain("export async function updateIndependentInstructorSettingsAction");
    expect(canonical).toMatch(/getEditableStudioContext\(returnTo\)/);
    expect(read("[id]", "page.tsx")).toContain("updateIndependentInstructorSettingsAction");
  });

  it("shows the hybrid promotion form only to viewers who can manage instructors", () => {
    const page = read("[id]", "page.tsx");
    expect(page).toContain("canManageInstructors");
    expect(page).toMatch(
      /isIndependentInstructor && typedClient\.linked_instructor_id && \(canManageInstructors\(role\) \|\| context\.isPlatformAdmin\)/,
    );
  });
});

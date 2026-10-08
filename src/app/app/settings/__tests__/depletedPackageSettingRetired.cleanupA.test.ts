import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Cleanup PR A: attaching a package to a booking always follows the canonical package eligibility rule, so the old
 * "Depleted packages: Block booking / Warn only" setting no longer controls anything. It must not be shown (a no-op
 * toggle would mislead staff), the settings save must not keep writing it, and no runtime code may read it. The
 * `studio_settings.block_depleted_package_booking` column itself stays as dormant schema (no SQL in this change).
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "__tests__" && !entry.name.startsWith(".")) {
        out.push(...sourceFiles(path));
      }
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

describe("retired depleted-package booking setting", () => {
  it("the settings form no longer offers the no-op Block booking / Warn only toggle for depleted packages", () => {
    const form = readFileSync("src/app/app/settings/SettingsForm.tsx", "utf8");
    expect(form).not.toContain("blockDepletedPackageBooking");
    expect(form).not.toContain("block_depleted_package_booking");
    // the real, separate controls stay
    expect(form).toContain('name="blockDepletedMembershipBooking"');
    expect(form).toContain('name="warnLowPackageBalance"');
  });

  it("the settings save no longer writes the dormant column", () => {
    const actions = readFileSync("src/app/app/settings/actions.ts", "utf8");
    expect(actions).not.toContain("block_depleted_package_booking");
    expect(actions).not.toContain("blockDepletedPackageBooking");
  });

  it("no runtime code reads the column (comments excepted)", () => {
    const readers = sourceFiles("src").filter((file) =>
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .some((line) => line.includes("block_depleted_package_booking") && !/^\s*(\*|\/\/)/.test(line)),
    );
    expect(readers).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { getSellWorkspaceNavItems } from "../SellWorkspaceNav";

// Scope: this only tests the FC-1B1 expenses-lockdown contradiction fix on
// today's host-relationship independent_instructor role and this specific
// host-studio nav component. It does not assert, and must not be read as
// asserting, that independent instructors are permanently excluded from
// commerce/expenses capabilities -- the future Independent Instructor
// Business Workspace persona is a separate, not-yet-implemented role (see
// FC-1B4 revision) with its own capability model still to be designed.
describe("getSellWorkspaceNavItems - host-relationship independent_instructor role (FC-1B4)", () => {
  it("gets no items on this host-studio nav today (matches the FC-1B1 /app/expenses page lockdown)", () => {
    const items = getSellWorkspaceNavItems("independent_instructor", false);

    expect(items).toEqual([]);
    expect(items.some((item) => item.href === "/app/expenses")).toBe(false);
  });

  it("studio_admin still gets Expenses (FC-1B1 lockdown contradiction fixed, not the real access)", () => {
    const items = getSellWorkspaceNavItems("studio_admin", false);

    expect(items.some((item) => item.href === "/app/expenses")).toBe(true);
  });

  it("studio_owner still gets Expenses", () => {
    const items = getSellWorkspaceNavItems("studio_owner", false);

    expect(items.some((item) => item.href === "/app/expenses")).toBe(true);
  });

  it("organizer roles still get Expenses via isOrganizerWorkspaceRole", () => {
    const items = getSellWorkspaceNavItems("organizer_owner", false);

    expect(items.some((item) => item.href === "/app/expenses")).toBe(true);
  });

  it("front_desk does not get Expenses (unchanged by this fix)", () => {
    const items = getSellWorkspaceNavItems("front_desk", false);

    expect(items.some((item) => item.href === "/app/expenses")).toBe(false);
  });
});

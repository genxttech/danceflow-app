import { describe, expect, it } from "vitest";
import { clientCellForRow } from "@/app/app/reports/export/appointments/route";

/**
 * GC-1.3A: a group_class row has no single client_id -- the appointments
 * CSV export previously rendered a blank "Client" cell and no way to
 * recover what the row even was. clientCellForRow now falls back to the
 * appointment's own title/type label; lesson rows (which always have a
 * client) are unchanged.
 */
describe("clientCellForRow", () => {
  it("falls back to the appointment title when there is no client", () => {
    expect(clientCellForRow(null, "Bronze Foxtrot", "group_class")).toBe(
      "Bronze Foxtrot",
    );
  });

  it("falls back to the type label when there is no client and no title", () => {
    expect(clientCellForRow(null, null, "group_class")).toBe("Group Class");
  });

  it("never renders a blank cell for a clientless row", () => {
    expect(clientCellForRow(null, null, "group_class")).not.toBe("");
  });

  it("shows the client's name when present (lesson behavior unchanged)", () => {
    expect(
      clientCellForRow({ first_name: "Ada", last_name: "Lovelace" }, "Lesson", "private_lesson"),
    ).toBe("Ada Lovelace");
  });
});

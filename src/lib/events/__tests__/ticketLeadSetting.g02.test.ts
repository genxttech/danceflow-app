import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("G-02 ticket form setting (source guard)", () => {
  const toggle = read("src/app/app/events/[id]/tickets/ProspectLeadToggle.tsx");
  const page = read("src/app/app/events/[id]/tickets/page.tsx");
  const actions = read("src/app/app/events/[id]/tickets/actions.ts");

  it("the toggle is unchecked by default and only rendered for kinds that may be flagged", () => {
    expect(toggle).toContain("defaultChecked = false");
    expect(toggle).toContain("ticketKindMayCreateLeads(kind)");
    expect(toggle).toContain('name="createsProspectLead"');
    expect(toggle).toContain('name="createsProspectLeadPresent"');
  });

  it("the tickets page shows the setting on create and on edit and loads the stored value", () => {
    expect(page.match(/<ProspectLeadToggle/g)?.length).toBe(2);
    expect(page).toContain("creates_prospect_lead");
    expect(page).toMatch(/<ProspectLeadToggle initialKind="general_admission" \/>/);
  });

  it("create/update persist the flag only for flaggable kinds; forms without the control never change it", () => {
    expect(actions).toContain("...prospectLeadFields(formData, ticketKind, \"create\")");
    expect(actions).toContain("...prospectLeadFields(formData, ticketKind, \"update\")");
    expect(actions).toContain('if (!ticketKindMayCreateLeads(ticketKind)) return { creates_prospect_lead: false };');
    expect(actions).toContain('formData.get("createsProspectLeadPresent") !== "1") return {}');
  });
});

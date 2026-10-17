import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBusinessFile, isInsideDirectory } from "../validation/businessFile";

const good = {
  legal_name: "Synthetic Test LLC",
  entity_type: "llc",
  industry: "EDUCATION",
  website_choice: "own",
  website_url: "https://example.test",
  address_line1: "1 Synthetic Way",
  address_line2: "",
  city: "Portland",
  region: "OR",
  postal_code: "97201",
  rep_first_name: "Syn",
  rep_last_name: "Thetic",
  rep_title: "Owner",
  rep_position: "ceo",
  rep_email: "owner@example.test",
  rep_phone: "(503) 555-0100",
  preferred_area_code: "503",
};

describe("Stage B business file check", () => {
  it("passes a complete synthetic file and reports no values", () => {
    const r = checkBusinessFile(good);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("Synthetic Way");
    expect(JSON.stringify(r)).not.toContain("owner@example.test");
    expect(r.fields.address_line2).toBe("optional-empty");
  });
  it("rejects the committed template (placeholders) and lists every unfilled field", () => {
    const tpl = JSON.parse(readFileSync(resolve(__dirname, "../../../../../scripts/tw4-validation/stage-b-business.template.json"), "utf8"));
    const r = checkBusinessFile(tpl);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field)).toEqual(expect.arrayContaining(["legal_name", "address_line1", "city", "region", "postal_code", "rep_email"]));
  });
  it("refuses an EIN or secret in the file without echoing it", () => {
    const r = checkBusinessFile({ ...good, ein: "12-3456789", api_secret: "abc" });
    expect(r.ok).toBe(false);
    expect(r.errors.filter((e) => e.field === "ein" || e.field === "api_secret")).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain("3456789");
  });
  it("applies the wizard rules (state, ZIP, phone, https website, area code)", () => {
    const r = checkBusinessFile({ ...good, region: "ZZ", postal_code: "1234", rep_phone: "123", website_url: "http://example.test", preferred_area_code: "123" });
    expect(r.ok).toBe(false);
    for (const f of ["region", "postal_code", "rep_phone", "website_url", "preferred_area_code"]) expect(r.fields[f]).toBe("error");
  });
  it("rejects non-object input and non-string values", () => {
    expect(checkBusinessFile([]).ok).toBe(false);
    expect(checkBusinessFile(null).ok).toBe(false);
    expect(checkBusinessFile({ ...good, city: 5 }).fields.city).toBe("error");
  });
  it("notes the Primary-profile name and industry facts without blocking", () => {
    const same = checkBusinessFile({ ...good, legal_name: "Genx TotalTech LLC" });
    expect(same.ok).toBe(true);
    expect(same.notes.join(" ")).toContain("identical");
    expect(same.notes.join(" ")).toContain("TECHNOLOGY");
    const cap = checkBusinessFile({ ...good, legal_name: "GenX TotalTech LLC" });
    expect(cap.warnings.some((w) => w.field === "legal_name")).toBe(true);
  });
  it("detects paths inside the repository", () => {
    expect(isInsideDirectory("C:\\Dev\\studioapp-tw4a\\x\\a.json", "C:/Dev/studioapp-tw4a")).toBe(true);
    expect(isInsideDirectory("C:\\Dev\\studioapp-tw4a-other\\a.json", "C:/Dev/studioapp-tw4a")).toBe(false);
    expect(isInsideDirectory("C:\\Users\\me\\AppData\\a.json", "C:/Dev/studioapp-tw4a")).toBe(false);
  });
});

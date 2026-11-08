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
  it("refuses the ISV's own legal identity as a Secondary-profile subject, in any spelling", () => {
    for (const legal_name of ["Genx TotalTech LLC", "GenX TotalTech LLC", "GENX TOTALTECH, L.L.C.", "Gen-X Total Tech LLC", "TotalTech Dance Co", "GenX Dance Holdings"]) {
      const r = checkBusinessFile({ ...good, legal_name });
      expect(r.ok, legal_name).toBe(false);
      expect(r.fields.legal_name, legal_name).toBe("error");
    }
    expect(JSON.stringify(checkBusinessFile({ ...good, legal_name: "Genx TotalTech LLC" }))).not.toContain("Genx TotalTech LLC");
  });
  it("accepts a studio entity of any supported type and does not compare it to the Primary profile", () => {
    for (const entity_type of ["llc", "corporation", "partnership", "non_profit", "cooperative"]) {
      const r = checkBusinessFile({ ...good, legal_name: "Another Studio Inc", entity_type });
      expect(r.ok, entity_type).toBe(true);
      expect(r.warnings.some((w) => w.field === "legal_name")).toBe(false);
      expect(r.notes.join(" ")).not.toMatch(/TECHNOLOGY|Primary profile/);
    }
  });
  it("refuses an ISV (DanceFlow) address as the representative's email", () => {
    const r = checkBusinessFile({ ...good, rep_email: "compliance@idanceflow.com" });
    expect(r.ok).toBe(false);
    expect(r.fields.rep_email).toBe("error");
  });
  it("is studio-neutral: no studio is named in the committed template or the checker's output", () => {
    const tpl = readFileSync(resolve(__dirname, "../../../../../scripts/tw4-validation/stage-b-business.template.json"), "utf8");
    expect(tpl).not.toMatch(/genx|confidance/i);
    expect(JSON.stringify(checkBusinessFile(good))).not.toMatch(/genx|confidance/i);
  });
  it("detects paths inside the repository", () => {
    expect(isInsideDirectory("C:\\Dev\\studioapp-tw4a\\x\\a.json", "C:/Dev/studioapp-tw4a")).toBe(true);
    expect(isInsideDirectory("C:\\Dev\\studioapp-tw4a-other\\a.json", "C:/Dev/studioapp-tw4a")).toBe(false);
    expect(isInsideDirectory("C:\\Users\\me\\AppData\\a.json", "C:/Dev/studioapp-tw4a")).toBe(false);
  });
});

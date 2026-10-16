import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DRAFT_FIELD_KEYS,
  ENTITY_TYPES,
  INDUSTRIES,
  REP_POSITIONS,
  emptyDraft,
  missingRequired,
  normalizeEin,
  normalizeWebsite,
  prefillDraft,
  validateDraftFields,
} from "@/lib/sms/onboarding/fields";

const SQL = readFileSync(join(process.cwd(), "src", "lib", "supabase", "migrations", "20261119090000_twilio_tw4a_sms_onboarding.sql"), "utf8").replace(/\r\n/g, "\n");

const valid = {
  legal_name: "Harbor Dance Studio LLC",
  entity_type: "llc",
  industry: "EDUCATION",
  website_choice: "danceflow",
  address_line1: "12 Harbor Way",
  city: "Portland",
  region: "OR",
  postal_code: "97201",
  rep_first_name: "Pat",
  rep_last_name: "Morgan",
  rep_title: "Owner",
  rep_position: "ceo",
  rep_email: "pat@harbordance.example",
  rep_phone: "(503) 555-0123",
  preferred_area_code: "503",
};

describe("EIN", () => {
  it("accepts 12-3456789 and 123456789 and derives the last four", () => {
    for (const input of ["12-3456789", "123456789", " 12-3456789 "]) {
      const result = normalizeEin(input);
      expect(result).toEqual({ ok: true, digits: "123456789", formatted: "12-3456789", last4: "6789" });
    }
  });
  it("rejects malformed and obviously fake values without echoing them", () => {
    for (const input of ["", "98-76543", "9876543210", "zz-9876543", "11-1111111", "000000000", "98 7654321"]) {
      const result = normalizeEin(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toContain(input.trim() || "\u0000");
    }
  });
});

describe("website", () => {
  it("adds https, keeps https, refuses http and nonsense", () => {
    expect(normalizeWebsite("www.harbordance.example")).toEqual({ ok: true, value: "https://www.harbordance.example" });
    expect(normalizeWebsite("https://harbordance.example/about")).toEqual({ ok: true, value: "https://harbordance.example/about" });
    expect(normalizeWebsite("")).toEqual({ ok: true, value: "" });
    expect(normalizeWebsite("http://harbordance.example").ok).toBe(false);
    expect(normalizeWebsite("not a site").ok).toBe(false);
    expect(normalizeWebsite("https://" + "a".repeat(300) + ".com").ok).toBe(false);
  });
});

describe("validateDraftFields", () => {
  it("normalizes a complete draft with no errors (phone to E.164, region upper-cased, email lower-cased)", () => {
    const result = validateDraftFields({ ...valid, region: "or", rep_email: "Pat@HarborDance.example" });
    expect(result.errors).toEqual({});
    expect(result.fields.rep_phone).toBe("+15035550123");
    expect(result.fields.region).toBe("OR");
    expect(result.fields.rep_email).toBe("pat@harbordance.example");
  });
  it("reports each bad field with its own message and drops unknown keys", () => {
    const result = validateDraftFields({
      legal_name: "X",
      entity_type: "sole_prop",
      industry: "RETAIL",
      region: "Oregon",
      postal_code: "9720",
      rep_phone: "12345",
      rep_email: "nope",
      preferred_area_code: "103",
      website_url: "http://x.example",
      ein: "12-3456789",
      state: "active",
    } as Record<string, string>);
    expect(Object.keys(result.errors).sort()).toEqual(
      ["entity_type", "industry", "legal_name", "postal_code", "preferred_area_code", "region", "rep_email", "rep_phone", "website_url"].sort(),
    );
    expect(Object.keys(result.fields)).toEqual([...DRAFT_FIELD_KEYS]);
    expect(JSON.stringify(result)).not.toContain("123456789");
  });
  it("warns, without blocking, about PO boxes and free mailboxes", () => {
    const result = validateDraftFields({ ...valid, address_line1: "PO Box 12", rep_email: "pat@gmail.com" });
    expect(result.errors).toEqual({});
    expect(result.warnings.address_line1).toMatch(/PO box/i);
    expect(result.warnings.rep_email).toMatch(/business-domain/i);
  });
  it("allows an incomplete draft (empty values are not errors)", () => {
    expect(validateDraftFields({}).errors).toEqual({});
  });
});

describe("required fields mirror the database", () => {
  it("lists missing fields in the exact order of public._sms_onb_missing", () => {
    const sqlBlock = SQL.slice(SQL.indexOf("create or replace function public._sms_onb_missing"), SQL.indexOf("-- Platform admin: pilot access"));
    const sqlKeys = [...sqlBlock.matchAll(/then '([a-z0-9_]+)' end/g)].map((m) => m[1]);
    // with website_choice already set to "own" the SQL list is its full list minus website_choice itself
    expect(missingRequired({ website_choice: "own" }, false)).toEqual(sqlKeys.filter((key) => key !== "website_choice"));
    expect(missingRequired({}, false)).toEqual(sqlKeys.filter((key) => key !== "website_url"));
    expect(sqlKeys).toContain("website_choice");
    expect(missingRequired({}, false)[0]).toBe("legal_name");
  });
  it("a complete draft with the EIN on file has nothing missing; own website needs a URL", () => {
    expect(missingRequired(valid, true)).toEqual([]);
    expect(missingRequired(valid, false)).toEqual(["ein"]);
    expect(missingRequired({ ...valid, website_choice: "own" }, true)).toEqual(["website_url"]);
  });
});

describe("pinned to the database checks", () => {
  const sqlList = (column: string) => {
    const match = new RegExp(`${column} text null check \\([^)]*in \\(([^)]*)\\)`).exec(SQL);
    return match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  };
  it("entity types, industries and positions equal the column checks", () => {
    expect(ENTITY_TYPES.map((e) => e.value).sort()).toEqual(sqlList("entity_type").sort());
    expect(INDUSTRIES.map((e) => e.value).sort()).toEqual(sqlList("industry").sort());
    expect(REP_POSITIONS.map((e) => e.value).sort()).toEqual(sqlList("rep_position").sort());
  });
  it("the save RPC accepts exactly the wizard's draft keys", () => {
    const match = /c_keys constant text\[\] := array\[([\s\S]*?)\];/.exec(SQL);
    const sqlKeys = [...(match?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).filter((key) => key !== "country");
    expect(sqlKeys.sort()).toEqual([...DRAFT_FIELD_KEYS].sort());
  });
});

describe("prefill", () => {
  it("starts from studio and owner data without inventing anything", () => {
    const draft = prefillDraft(
      { name: "Harbor Dance", address_line_1: "12 Harbor Way", city: "Portland", state: "or", postal_code: "97201", public_phone: "(503) 555-0100", public_website_url: "harbordance.example" },
      { full_name: "Pat Q Morgan", email: "Pat@Harbor.example" },
    );
    expect(draft).toMatchObject({
      legal_name: "Harbor Dance",
      region: "OR",
      website_choice: "own",
      website_url: "https://harbordance.example",
      rep_first_name: "Pat",
      rep_last_name: "Q Morgan",
      rep_email: "pat@harbor.example",
      preferred_area_code: "503",
      industry: "",
      entity_type: "",
    });
  });
  it("falls back to the DanceFlow page and empties bad values", () => {
    const draft = prefillDraft({ state: "Oregon", postal_code: "abc" }, {});
    expect(draft.website_choice).toBe("danceflow");
    expect(draft.region).toBe("");
    expect(draft.postal_code).toBe("");
    expect(emptyDraft().legal_name).toBe("");
  });
});

import { FIELD_STEP, firstStepWith } from "@/lib/sms/onboarding/fields";

describe("wizard step mapping", () => {
  it("maps every field to a step so an error is never hidden", () => {
    for (const key of [...DRAFT_FIELD_KEYS, "ein"]) expect(FIELD_STEP[key as keyof typeof FIELD_STEP]).toBeGreaterThanOrEqual(0);
  });
  it("finds the earliest step with a problem and ignores unknown names", () => {
    expect(firstStepWith(["rep_email", "city"])).toBe(0);
    expect(firstStepWith(["rep_email"])).toBe(1);
    expect(firstStepWith(["preferred_area_code", "rep_phone"])).toBe(1);
    expect(firstStepWith(["preferred_area_code"])).toBe(2);
    expect(firstStepWith(["ein"])).toBe(0);
    expect(firstStepWith(["nope"])).toBeNull();
    expect(firstStepWith([])).toBeNull();
  });
});

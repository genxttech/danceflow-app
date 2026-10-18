import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CATALOG, explainCode } from "../errorCatalog";
import { describeOutcome } from "../outcomes";

const runner = readFileSync(join(__dirname, "../runner.ts"), "utf8");

describe("TW-4F-2b error-to-action catalog", () => {
  it("every entry says who acts, what happened and what to do", () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(["owner", "platform", "twilio"], code).toContain(entry.who);
      expect(entry.summary.length, code).toBeGreaterThan(10);
      expect(entry.action.length, code).toBeGreaterThan(10);
    }
  });

  it("owner-facing entries never use registration vocabulary (Twilio, brand, campaign, trust product, carrier)", () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG).filter(([, e]) => e.who === "owner")) {
      expect(`${entry.summary} ${entry.action}`, code).not.toMatch(/twilio|brand|campaign|trust product|carrier|ledger/i);
    }
  });

  it("covers every error code and failure token the runner can produce (a new failure mode cannot ship unexplained)", () => {
    const code = runner.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const found = new Set<string>();
    for (const m of code.matchAll(/errorCode: "([a-z_]+)"/g)) found.add(m[1]);
    for (const m of code.matchAll(/errorCode: [a-z]+ \? "([a-z_]+)" : "([a-z_]+)"/g)) {
      found.add(m[1]);
      found.add(m[2]);
    }
    for (const m of code.matchAll(/move\("[a-z_]+", [^,]+, "([a-z_]+)"/g)) found.add(m[1]);
    for (const m of code.matchAll(/move\("[a-z_]+", [^,]+, [a-z]+ \? "([a-z_]+)" : "([a-z_]+)"/g)) {
      found.add(m[1]);
      found.add(m[2]);
    }
    for (const m of code.matchAll(/:(preverify_[a-z]+|evaluation_stale|confirmation_missing|attempt_unresolved|brand_exists|ambiguous_fee_step|ambiguous_match|noncompliant_unmapped|evaluation_unrecognized|review)\b/g)) found.add(m[1]);
    for (const m of code.matchAll(/"(brand_unexpected_status|brand_rejected|brand_suspended|profile_rejected|trust_product_rejected)"/g)) found.add(m[1]);
    found.add("brand_mirror_failed");
    expect(found.size).toBeGreaterThan(15);
    expect([...found].filter((token) => !ERROR_CATALOG[token]), "codes without a catalog entry").toEqual([]);
  });

  it("explainCode finds the first known token in run details and ledger codes, and nothing for the unknown", () => {
    expect(explainCode("S10:noncompliant:email")?.who).toBe("owner");
    expect(explainCode("S11:review")?.who).toBe("platform");
    expect(explainCode("profile_rejected;profile=twilio-rejected")?.summary).toMatch(/rejected the business profile/);
    expect(explainCode("brand:rejected")?.action).toMatch(/Twilio's reason/);
    expect(explainCode("in-review")?.who).toBe("twilio");
    for (const nothing of [null, undefined, "", "zzz:yyy", "42"]) expect(explainCode(nothing as never)).toBeNull();
  });

  it("platform messages for stops carry the plain next step; observations and waiting states do not repeat it", () => {
    expect(describeOutcome("exception", "S10:evaluation_unrecognized")).toContain("Next: Look at the step evidence");
    expect(describeOutcome("needs_info", "S10:noncompliant:rep_email")).toContain("Next: Ask the owner");
    expect(describeOutcome("exception", "profile_rejected;profile=twilio-rejected")).toContain("Next: Read Twilio's reason");
    expect(describeOutcome("exception", "profile_rejected")).toContain("(profile_rejected)");
    expect(describeOutcome("status_checked", "profile=in-review;trust_product=draft")).toContain("Nothing was created, submitted or paid");
    expect(describeOutcome("brand_in_review", null)).not.toContain("Next:");
  });
});

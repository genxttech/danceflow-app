import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderRflAlertEmail, sanitizeRflSummary } from "../templates";

/**
 * Campaign-orphan alerts (R2a, migration 20261212) travel through the lifecycle's existing alert queue and the existing operational email sink as kind
 * `inventory_gap`. This pins what an OWNER and an ADMINISTRATOR would actually receive: the stored summaries pass the sink's sanitizer UNCHANGED (so the generic
 * fallback, which tells an owner to register a resource, is never used for an orphan), and no rendered mail carries a provider identifier, an amount or a request
 * for the studio to authorize anything.
 */
const MIGRATION = readFileSync(path.resolve(process.cwd(), "src/lib/supabase/migrations/20261212090000_twilio_prov_fee_resolution_evidence.sql"), "utf8");
const ownerLiteral = /'(DanceFlow found a texting registration on your account that it did not expect[^']*)'/.exec(MIGRATION)?.[1] ?? "";
const adminLiteral = /'(A provider campaign not accounted for by the ledger was found for this business \(orphan )'/.exec(MIGRATION)?.[1] ?? "";
const ORPHAN_ID = "5b3c9f1e-0a52-4e53-8d57-6d3f5a7e9c11";
const adminSummary = `${adminLiteral}${ORPHAN_ID}). Fee-bearing provisioning is blocked until it is reconciled.`;

const SID = /\b[A-Za-z]{2}[0-9a-fA-F]{32}\b/;
const MONEY = /\$\s*\d|\d\s*\$|\b(?:cents?|usd|dollars?|invoice|balance)\b/i;
const SOLICIT = /\b(authori[sz]e|authori[sz]ation|renew|register|approve|pay|fund)\b/i;

describe("orphan alerts through the existing operational email sink", () => {
  it("the stored summaries are the ones pinned here (drift guard against the migration)", () => {
    expect(ownerLiteral).toMatch(/^DanceFlow found a texting registration on your account that it did not expect and is looking into it\./);
    expect(adminLiteral).not.toBe("");
  });

  it("the owner summary passes the sanitizer unchanged, so the generic fallback is never used for an orphan", () => {
    expect(sanitizeRflSummary("inventory_gap", ownerLiteral)).toBe(ownerLiteral);
    expect(sanitizeRflSummary("inventory_gap", adminSummary)).toBe(adminSummary);
  });

  it("the owner email is investigatory and sanitized: no identifier, no amount, no request to authorize, register or pay", () => {
    const mail = renderRflAlertEmail({ kind: "inventory_gap", summary: ownerLiteral, recipientKind: "owner", studioName: "Studio A" });
    const text = `${mail.subject}\n${mail.bodyText}\n${mail.bodyHtml}`.replace(/<[^>]*>/g, " ");
    expect(mail.templateKey).toBe("platform_rfl_inventory_gap");
    expect(mail.bodyText).toContain(ownerLiteral);
    expect(mail.bodyText).toContain("You do not need to do anything.");
    expect(text).not.toMatch(SID);
    expect(text).not.toMatch(MONEY);
    expect(ownerLiteral).not.toMatch(SOLICIT);
    expect(ownerLiteral).not.toMatch(/orphan/i);
  });

  it("the administrator email uses the admin template key (hidden from studio staff) and carries the orphan reference but no provider identifier or amount", () => {
    const mail = renderRflAlertEmail({ kind: "inventory_gap", summary: adminSummary, recipientKind: "admin" });
    expect(mail.templateKey).toBe("platform_rfl_admin_inventory_gap");
    expect(mail.templateKey).not.toBe("platform_rfl_inventory_gap");
    expect(mail.bodyText).toContain(ORPHAN_ID);
    expect(`${mail.subject}\n${mail.bodyText}`).not.toMatch(SID);
    expect(`${mail.subject}\n${mail.bodyText}`).not.toMatch(MONEY);
  });

  it("a summary that would leak a provider identifier or an amount is replaced, never sent as written", () => {
    for (const leaked of [`Campaign QE${"a".repeat(32)} was found`, "A $14 monthly fee applies", "The balance is negative", "token sk_live_abc"]) {
      expect(sanitizeRflSummary("inventory_gap", leaked)).not.toBe(leaked);
    }
  });
});

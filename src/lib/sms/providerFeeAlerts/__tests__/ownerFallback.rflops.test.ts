import { describe, expect, it } from "vitest";
import { RFL_ALERT_KINDS, renderRflAlertEmail, sanitizeRflSummary } from "../templates";

const SID = /\b[A-Za-z]{2}[0-9a-fA-F]{32}\b/;
const MONEY = /\$\s*\d|\d\s*\$|\b(?:cents?|usd|dollars?|balance|invoice|token|credential|password|secret)\b/i;
const SOLICIT = /\b(authori[sz]e[ds]?|authori[sz]ation|renew|register|adopt|approve|accept|pay|fund|charge[ds]?)\b/i;
const REJECTED = [
  `Campaign QE${"a".repeat(32)} was found`,
  "A $14 monthly fee applies",
  "The balance is negative",
  "token sk_live_abc",
  "provider error: cents mismatch",
  "",
];
const strip = (html: string) => html.replace(/<[^>]*>/g, " ");

describe("owner-facing inventory_gap fallback (used when the supplied summary is rejected)", () => {
  it("is neutral and informational: investigating, no action, no request to register, adopt, authorize, accept or pay", () => {
    for (const bad of REJECTED) {
      const out = sanitizeRflSummary("inventory_gap", bad, "owner");
      expect(out).toContain("DanceFlow is investigating");
      expect(out).toContain("no action is needed from you");
      expect(out).not.toMatch(SOLICIT);
      expect(out).not.toMatch(SID);
      expect(out).not.toMatch(MONEY);
    }
  });

  it("the rendered owner email uses the neutral subject, heading and body, with no solicitation, identifier, amount or internal detail", () => {
    for (const bad of REJECTED) {
      const mail = renderRflAlertEmail({ kind: "inventory_gap", summary: bad, recipientKind: "owner", studioName: "Rhythm Studio" });
      const text = `${mail.subject}\n${mail.bodyText}\n${strip(mail.bodyHtml)}`;
      expect(mail.subject).toBe("We are looking into an unexpected texting resource");
      expect(text).toContain("DanceFlow is investigating");
      expect(text).not.toMatch(/Register it/i);
      expect(text).not.toMatch(SOLICIT);
      expect(text).not.toMatch(SID);
      expect(text).not.toMatch(MONEY);
      expect(mail.templateKey).toBe("platform_rfl_inventory_gap");
    }
  });

  it("a clean owner summary is still sent unchanged (sanitized-summary behaviour preserved)", () => {
    const clean = "DanceFlow found a texting registration on your account that it did not expect and is looking into it. You do not need to do anything.";
    expect(sanitizeRflSummary("inventory_gap", clean, "owner")).toBe(clean);
    const mail = renderRflAlertEmail({ kind: "inventory_gap", summary: clean, recipientKind: "owner" });
    expect(mail.bodyText).toContain(clean);
  });

  it("the administrator copy and the two-argument call keep the original inventory-gap workflow wording", () => {
    const admin = renderRflAlertEmail({ kind: "inventory_gap", summary: "A $14 fee", recipientKind: "admin" });
    expect(admin.subject).toBe("A texting resource is not being monitored");
    expect(admin.bodyText).toContain("Register it before activating the studio.");
    expect(admin.templateKey).toBe("platform_rfl_admin_inventory_gap");
    expect(sanitizeRflSummary("inventory_gap", "A $14 fee")).toContain("Register it before activating the studio.");
  });

  it("no other kind changes for owners or admins: every other kind has the same copy for both audiences", () => {
    for (const kind of RFL_ALERT_KINDS.filter((k) => k !== "inventory_gap")) {
      expect(sanitizeRflSummary(kind, "a $5 fee", "owner")).toBe(sanitizeRflSummary(kind, "a $5 fee", "admin"));
      const o = renderRflAlertEmail({ kind, summary: "x", recipientKind: "owner" });
      const a = renderRflAlertEmail({ kind, summary: "x", recipientKind: "admin" });
      expect(o.subject).toBe(a.subject);
    }
    expect(renderRflAlertEmail({ kind: "brand_new_kind", summary: "$5", recipientKind: "owner" }).subject).toBe("Texting provider fee notice");
  });
});

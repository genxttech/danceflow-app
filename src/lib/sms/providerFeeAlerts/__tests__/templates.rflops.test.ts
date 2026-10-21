import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { RFL_ALERT_KINDS, renderRflAlertEmail, sanitizeRflSummary } from "../templates";

const SID = /\b(?:AC|PN|QE|MG|SM)[0-9a-fA-F]{32}\b/;
const visibleText = (html: string) => html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");

function scan(text: string) {
  expect(text).not.toMatch(SID);
  expect(text).not.toMatch(/\$/);
  expect(text).not.toMatch(/cents/i);
  expect(text).not.toMatch(/token/i);
  expect(text).not.toMatch(/balance/i);
}

describe("RFL alert email templates", () => {
  const hex = "0123456789abcdef0123456789abcdef";
  const hostile = `Owner action needed AC${hex} PN${hex} $12.50 balance 1250 cents token abc`;

  it("every kind renders a platform_ system template with a sensible subject, a link, and no provider-sensitive data (clean and hostile summaries)", () => {
    for (const kind of RFL_ALERT_KINDS) {
      for (const recipientKind of ["owner", "admin"] as const) {
        for (const summary of ["Your authorization ends in 30 days.", hostile, ""]) {
          const mail = renderRflAlertEmail({ kind, summary, recipientKind, studioName: "Rhythm Studio" });
          expect(mail.templateKey).toBe(`platform_rfl_${kind}`);
          expect(mail.templateKey.startsWith("platform_")).toBe(true);
          expect(mail.subject.length).toBeGreaterThan(5);
          for (const part of [mail.subject, mail.bodyText, visibleText(mail.bodyHtml)]) scan(part);
          expect(mail.bodyText).toContain(recipientKind === "owner" ? "/app/settings/sms" : "/platform/sms");
          expect(mail.bodyHtml).toContain(recipientKind === "owner" ? "/app/settings/sms" : "/platform/sms");
          expect(mail.bodyHtml).toMatch(/<html/i);
          if (recipientKind === "owner") expect(mail.bodyText).toContain("Studio: Rhythm Studio");
          else expect(mail.bodyText).not.toContain("Rhythm Studio");
        }
      }
    }
  });

  it("the whole raw HTML (not only visible text) carries no SID, dollar amount or credential words", () => {
    for (const kind of RFL_ALERT_KINDS) {
      const mail = renderRflAlertEmail({ kind, summary: hostile, recipientKind: "owner", studioName: "Rhythm Studio" });
      expect(mail.bodyHtml).not.toMatch(SID);
      expect(mail.bodyHtml).not.toMatch(/\$\s*\d/);
    }
  });

  it("a clean summary is used verbatim (control characters and length are cleaned); a sensitive one is replaced by the kind's generic sentence", () => {
    expect(sanitizeRflSummary("exposure_open", "A fee for a texting resource is not covered.")).toBe("A fee for a texting resource is not covered.");
    expect(sanitizeRflSummary("exposure_open", "line\u0000one\n\ntwo")).toBe("line one two");
    expect(sanitizeRflSummary("exposure_open", "x".repeat(900)).length).toBe(300);
    for (const bad of [`id AC${hex}`, "owes $5", "5 $", "balance is low", "3 cents", "the token", "invoice 123", "sk_live_abc"]) {
      expect(sanitizeRflSummary("exposure_open", bad)).toBe("A provider fee for a texting resource is not covered and needs review.");
    }
  });

  it("an unknown kind falls back to a generic platform_ template instead of failing", () => {
    const mail = renderRflAlertEmail({ kind: "brand_new_kind", summary: "Something needs review.", recipientKind: "admin" });
    expect(mail.templateKey).toBe("platform_rfl_alert");
    expect(mail.bodyText).toContain("Something needs review.");
  });

  it("a hostile studio name is length-capped and HTML-escaped", () => {
    const mail = renderRflAlertEmail({ kind: "funding_low", summary: "ok", recipientKind: "owner", studioName: `<script>alert(1)</script>${"n".repeat(200)}` });
    expect(mail.bodyHtml).not.toContain("<script>");
    expect(mail.bodyText.split("\n")[0].length).toBeLessThanOrEqual(90);
  });
});

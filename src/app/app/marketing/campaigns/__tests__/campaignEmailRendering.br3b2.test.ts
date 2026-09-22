import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCampaignEmailHtml,
  buildCampaignEmailText,
  type CampaignEmailParams,
} from "../campaignEmail";

const BASE_PARAMS: CampaignEmailParams = {
  studioName: "Acme Dance",
  studioLogoUrl: "https://cdn.example.com/logo.png",
  subject: "October studio update",
  previewText: null,
  bodyText: "We are adding a new Saturday class this month -- come try it out!",
  ctaLabel: "See the schedule",
  ctaUrl: "https://www.idanceflow.com/app",
  footerNote: "Acme Dance LLC · 123 Main St · Springfield, IL 62704 · Sent with DanceFlow.",
  unsubscribeUrl: "https://www.idanceflow.com/unsubscribe/marketing/tok_abc123",
};

describe("buildCampaignEmailHtml (BR-3B2 defect G: body/unsubscribe)", () => {
  it("the campaign body remains present in the HTML even when an unsubscribe block exists", () => {
    const html = buildCampaignEmailHtml(BASE_PARAMS);
    expect(html).toContain(BASE_PARAMS.bodyText);
  });

  it("the unsubscribe link is present and clickable", () => {
    const html = buildCampaignEmailHtml(BASE_PARAMS);
    expect(html).toContain(`href="${BASE_PARAMS.unsubscribeUrl}"`);
    expect(html).toContain("Unsubscribe");
  });

  it("no unsubscribeUrl -> no unsubscribe block, body still present", () => {
    const html = buildCampaignEmailHtml({ ...BASE_PARAMS, unsubscribeUrl: null });
    expect(html).toContain(BASE_PARAMS.bodyText);
    expect(html).not.toContain("Unsubscribe");
  });

  it("visible branding uses the passed (public_name-resolved) studio name", () => {
    const html = buildCampaignEmailHtml(BASE_PARAMS);
    expect(html).toContain("Acme Dance");
  });

  it("the legal/business name + address compliance line is present in the compliance block", () => {
    const html = buildCampaignEmailHtml(BASE_PARAMS);
    expect(html).toContain("Acme Dance LLC");
    expect(html).toContain("123 Main St");
  });

  it("canonical DanceFlow attribution and legal line are never overridden by the compliance block", () => {
    const html = buildCampaignEmailHtml(BASE_PARAMS);
    expect(html).toContain("Sent by Acme Dance through DanceFlow.");
    expect(html).toContain("DanceFlow is a product of GenX TotalTech LLC.");
  });

  it("footer hierarchy order: body, then compliance/unsubscribe block, then canonical attribution, then legal line", () => {
    const html = buildCampaignEmailHtml(BASE_PARAMS);
    const bodyIndex = html.indexOf(BASE_PARAMS.bodyText);
    const complianceIndex = html.indexOf("123 Main St");
    const unsubscribeIndex = html.indexOf("Unsubscribe");
    const attributionIndex = html.indexOf("Sent by Acme Dance through DanceFlow.");
    const legalIndex = html.indexOf("DanceFlow is a product of GenX TotalTech LLC.");

    expect(bodyIndex).toBeGreaterThan(-1);
    expect(bodyIndex).toBeLessThan(complianceIndex);
    expect(complianceIndex).toBeLessThan(unsubscribeIndex);
    expect(unsubscribeIndex).toBeLessThan(attributionIndex);
    expect(attributionIndex).toBeLessThan(legalIndex);
  });

  it("the CTA button renders from ctaLabel/ctaUrl and does not consume the footerHtml slot", () => {
    const html = buildCampaignEmailHtml(BASE_PARAMS);
    expect(html).toContain("See the schedule");
    expect(html).toContain(`href="${BASE_PARAMS.ctaUrl}"`);
  });

  it("escapes user-controlled compliance/studio values before interpolation", () => {
    const html = buildCampaignEmailHtml({
      ...BASE_PARAMS,
      studioName: '<script>alert(1)</script>',
      footerNote: '<b>Studio</b> & Co',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>Studio</b>");
  });
});

describe("buildCampaignEmailText", () => {
  it("plain text always includes the body regardless of the unsubscribe footer", () => {
    const text = buildCampaignEmailText(BASE_PARAMS);
    expect(text).toContain(BASE_PARAMS.bodyText);
    expect(text).toContain("Unsubscribe:");
    expect(text).toContain(BASE_PARAMS.unsubscribeUrl!);
  });
});

describe("campaign send-site guards (BR-3B2 defects G: subject sanitizer + result.error)", () => {
  const source = readFileSync(
    join(process.cwd(), "src/app/app/marketing/campaigns/actions.ts"),
    "utf8",
  );

  it("the test-send site sanitizes the subject before using it anywhere", () => {
    expect(source).toMatch(/const subject = sanitizeEmailSubject\(`\[TEST\] \$\{campaign\.subject\}`\);/);
  });

  it("the bulk-send site sanitizes the subject before using it anywhere", () => {
    expect(source).toMatch(/const subject = sanitizeEmailSubject\(campaign\.subject\);/);
  });

  it("both live send sites pass the resend.emails.send call the sanitized `subject` variable, not the raw campaign.subject", () => {
    // Every `resend.emails.send({ ... subject, ... })` call site in this file must reference the local
    // sanitized `subject` variable, never `campaign.subject` directly.
    const sendCalls = source.match(/resend\.emails\.send\(\{[^}]*\}\)/g) ?? [];
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of sendCalls) {
      expect(call).not.toMatch(/subject:\s*campaign\.subject/);
      expect(call).not.toMatch(/subject:\s*`\[TEST\] \$\{campaign\.subject\}`/);
    }
  });

  it("the bulk-send loop checks result.error and routes a failure through the existing failed-status handling before ever marking a recipient sent", () => {
    const sendCallIndex = source.indexOf("const result = await resend.emails.send(");
    expect(sendCallIndex).toBeGreaterThan(-1);
    const afterSend = source.slice(sendCallIndex);
    // Immediately following the send call, `result.error` must be checked and thrown/handled before any
    // "status: sent" update -- i.e. the error-check must appear before the "sent" update in source order.
    const errorCheckIndex = afterSend.indexOf("if (result.error)");
    const sentUpdateIndex = afterSend.indexOf('status: "sent"');
    expect(errorCheckIndex).toBeGreaterThan(-1);
    expect(sentUpdateIndex).toBeGreaterThan(-1);
    expect(errorCheckIndex).toBeLessThan(sentUpdateIndex);
  });

  it("visible branding is resolved via the shared resolveStudioDisplayName helper at both send sites, not reinlined", () => {
    const occurrences = source.match(/resolveStudioDisplayName\(studio\)/g) ?? [];
    expect(occurrences.length).toBe(2);
    expect(source).not.toMatch(/studio\?\.public_name\?\.trim\(\) \|\| studio\?\.name/);
  });
});

describe("dead campaigns/[id]/actions.ts is untouched (out of scope, confirmed unreferenced)", () => {
  it("still contains the original contentHtml-based unsubscribe bug (left as pre-existing, unreachable dead code)", () => {
    const deadSource = readFileSync(
      join(process.cwd(), "src/app/app/marketing/campaigns/[id]/actions.ts"),
      "utf8",
    );
    expect(deadSource).toContain("contentHtml: unsubscribeHtml || undefined");
  });
});

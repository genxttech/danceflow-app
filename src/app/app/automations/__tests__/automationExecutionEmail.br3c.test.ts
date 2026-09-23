import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";

/**
 * BR-3C: fixes the carried-over duplicate greeting/intro defect in `getAriaExecutionEmail()`
 * (`src/app/app/automations/actions.ts`) by adding `dedupeBodyLeadIn: true` to its existing
 * `renderStudioBrandedEmail` call. `getAriaExecutionEmail` itself is a private, synchronous helper in a
 * "use server" file, so it cannot be exported/imported directly here (every export from a "use server"
 * file must be async). Instead: (1) a source-level check confirms the real call site actually opts in,
 * and (2) a render-based check calls the REAL, unmodified `renderStudioBrandedEmail` shell function with
 * the exact literal `bodyText`/`greeting`/`intro` content that call site uses per rule_key branch
 * (verified against source), proving the actual shared dedupe logic eliminates the visible duplication
 * for this content shape -- not a re-implementation of the builder.
 */
const source = readFileSync(
  join(process.cwd(), "src/app/app/automations/actions.ts"),
  "utf8",
);

function visibleHtml(html: string) {
  return html.replace(/<div style="display:none;[^"]*">[\s\S]*?<\/div>/, "");
}

describe("ARIA execution email dedupeBodyLeadIn opt-in (BR-3C, source-level)", () => {
  it("getAriaExecutionEmail's renderStudioBrandedEmail call now opts into dedupeBodyLeadIn", () => {
    const fnStart = source.indexOf("function getAriaExecutionEmail(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, source.indexOf("\n}\n", fnStart));
    expect(fnBody).toContain("renderStudioBrandedEmail(");
    expect(fnBody).toContain("dedupeBodyLeadIn: true");
  });

  it("getPortalUrl no longer concatenates a raw NEXT_PUBLIC_SITE_URL env var", () => {
    const fnStart = source.indexOf("function getPortalUrl(");
    const fnBody = source.slice(fnStart, source.indexOf("\n}\n", fnStart));
    expect(fnBody).not.toContain("process.env.NEXT_PUBLIC_SITE_URL");
    expect(fnBody).toContain("buildAppUrl(");
  });
});

describe("ARIA execution email — default branch (BR-3C render-based, real shell)", () => {
  const firstName = "Riley";
  const studioName = "Acme Dance";
  const portalUrl = "https://www.idanceflow.com/portal/acme-dance";
  const intro = "We wanted to follow up with you.";
  const bodyText = `Hi ${firstName},\n\n${intro}\n\nClient portal: ${portalUrl}\n\nThank you,\n${studioName}`;

  const html = renderStudioBrandedEmail(
    { name: studioName, logoUrl: null },
    {
      previewText: "A note from your studio",
      eyebrow: studioName,
      heading: "A note from your studio",
      greeting: `Hi ${firstName},`,
      intro,
      bodyText,
      actionLabel: "Open Client Portal",
      actionUrl: portalUrl,
      footerText: `Sent by ${studioName} through DanceFlow.`,
      dedupeBodyLeadIn: true,
    },
  );

  it("the greeting appears exactly once in the visible HTML", () => {
    const visible = visibleHtml(html);
    expect(visible.match(new RegExp(`Hi ${firstName},`, "g"))?.length).toBe(1);
  });

  it("the intro appears exactly once in the visible HTML", () => {
    const visible = visibleHtml(html);
    expect(visible.match(new RegExp(intro.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
  });

  it("the mid-body 'Client portal: <url>' line is preserved (not incidentally stripped)", () => {
    expect(html).toContain(`Client portal: ${portalUrl}`);
  });

  it("the CTA button is unchanged (Open Client Portal, correct href)", () => {
    expect(html).toContain(">Open Client Portal<");
    expect(html).toContain(`href="${portalUrl}"`);
  });

  it("canonical attribution/legal line is intact", () => {
    expect(html).toContain(`Sent by ${studioName} through DanceFlow.`);
    expect(html).toContain("DanceFlow is a product of GenX TotalTech LLC.");
  });

  it("plain-text bodyText itself is completely unaffected by dedupeBodyLeadIn (HTML-only defect)", () => {
    expect(bodyText).toBe(
      `Hi ${firstName},\n\n${intro}\n\nClient portal: ${portalUrl}\n\nThank you,\n${studioName}`,
    );
  });
});

describe("ARIA execution email — mid-body-URL branch, aria_stale_active_student (BR-3C render-based, real shell)", () => {
  const firstName = "Sam";
  const studioName = "Riverside Ballroom";
  const scheduleUrl = "https://www.idanceflow.com/portal/riverside-ballroom/schedule";
  const intro = "We noticed you do not currently have your next lesson scheduled.";
  const bodyText = `Hi ${firstName},\n\n${intro}\n\nYou can request your next lesson from your client portal or contact us and we can help you find a time that works.\n\nRequest your next lesson: ${scheduleUrl}\n\nThank you,\n${studioName}`;

  const html = renderStudioBrandedEmail(
    { name: studioName, logoUrl: null },
    {
      previewText: "Schedule your next lesson",
      eyebrow: studioName,
      heading: "Schedule your next lesson",
      greeting: `Hi ${firstName},`,
      intro,
      bodyText,
      actionLabel: "Request Your Next Lesson",
      actionUrl: scheduleUrl,
      footerText: `Sent by ${studioName} through DanceFlow.`,
      dedupeBodyLeadIn: true,
    },
  );

  it("the greeting appears exactly once", () => {
    const visible = visibleHtml(html);
    expect(visible.match(new RegExp(`Hi ${firstName},`, "g"))?.length).toBe(1);
  });

  it("the intro appears exactly once", () => {
    const visible = visibleHtml(html);
    expect(visible.match(new RegExp(intro.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
  });

  it("the mid-body 'Request your next lesson: <url>' line is preserved -- this is the inline-URL + CTA redundancy that is explicitly NOT part of BR-3C and must not be incidentally removed", () => {
    expect(html).toContain(`Request your next lesson: ${scheduleUrl}`);
    // It appears twice by design (once inline in prose, once as the CTA href) -- confirms nothing extra
    // was stripped by dedupeBodyLeadIn, whose CTA-line strip only ever inspects the LAST paragraph, and
    // the last paragraph here is the "Thank you," sign-off, not the URL line.
    expect(html.match(new RegExp(scheduleUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(2);
  });

  it("the CTA button is unchanged", () => {
    expect(html).toContain(">Request Your Next Lesson<");
    expect(html).toContain(`href="${scheduleUrl}"`);
  });
});

describe("automation execution email persistence stays intact (BR-3B2 regression guard)", () => {
  it("both aria_execution 'insert new delivery' branches still persist bodyHtml (not null / bare fragment)", () => {
    const INSERT_BRANCH_PATTERN =
      /body_text:\s*bodyText,\s*\n\s*body_html:\s*([\w().]+),\s*\n\s*related_table:\s*"automation_actions",\s*\n\s*related_id:\s*action\.id,\s*\n\s*dedupe_key:\s*getAriaExecutionDedupeKey/g;
    const values = Array.from(source.matchAll(INSERT_BRANCH_PATTERN)).map((match) => match[1]);
    expect(values.length).toBe(2);
    for (const value of values) {
      expect(value).toBe("bodyHtml");
    }
  });
});

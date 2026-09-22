import { describe, expect, it } from "vitest";
import { EMAIL_TOKENS, resolveStudioDisplayName } from "@/lib/email/brand";
import {
  renderBrandedEmail,
  renderDanceFlowSystemEmail,
  renderPlainTextAsStudioEmail,
  renderStudioBrandedEmail,
  stripBodyLeadIn,
} from "@/lib/notifications/email-branding";

const LOGO = "https://cdn.example.com/studio/logo.png";
const LEGAL = "DanceFlow is a product of GenX TotalTech LLC.";
const TOKEN_HEXES = new Set(Object.values(EMAIL_TOKENS).map((h) => h.toLowerCase()));
const LEGACY_HEXES = [
  "#4c1d95",
  "#2e1065",
  "#1e1b4b",
  "#f97316",
  "#be185d",
  "#f5f3f7",
  "#0f172a",
  "#fed7aa",
  "#e9e2ec",
  "#334155",
  "#64748b",
  "#e2e8f0",
  "#f8fafc",
  "#cbd5e1",
];

const base = {
  previewText: "Preview text",
  heading: "Your lesson is confirmed",
  bodyText: "First paragraph.\n\nSecond paragraph.",
};

function hexes(html: string) {
  return (html.match(/(?<![&\w])#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toLowerCase());
}

describe("system mode (DanceFlow primary)", () => {
  const html = renderDanceFlowSystemEmail({
    ...base,
    eyebrow: "Welcome",
    actionLabel: "Open DanceFlow",
    actionUrl: "https://www.idanceflow.com/app",
  });

  it("uses the canonical white primary logo at 180x45", () => {
    expect(html).toContain(
      '<img src="https://www.idanceflow.com/brand/logo/danceflow-logo-primary-white.png" width="180" height="45" alt="DanceFlow"',
    );
    expect(html).not.toMatch(/danceflow-logo\.png/);
    expect(html).not.toMatch(/localhost|vercel\.app/);
  });

  it("uses a solid primary header with a gradient enhancement", () => {
    expect(html).toContain(`bgcolor="${EMAIL_TOKENS.primary}"`);
    expect(html).toContain(
      `linear-gradient(135deg,${EMAIL_TOKENS.primary} 0%,${EMAIL_TOKENS.primaryDark} 100%)`,
    );
  });

  it("uses only the approved palette and no legacy email colours", () => {
    for (const hex of hexes(html)) expect(TOKEN_HEXES.has(hex), hex).toBe(true);
    for (const legacy of LEGACY_HEXES) expect(html.toLowerCase()).not.toContain(legacy);
    expect(html).toContain("font-family:Arial, Helvetica, sans-serif");
    expect(html).not.toMatch(/sora|@font-face|@import/i);
  });

  it("carries the system footer and the GenX legal line", () => {
    expect(html).toContain("This is a system message from DanceFlow.");
    expect(html).toContain(LEGAL);
  });

  it("styles the CTA as a primary-coloured button", () => {
    expect(html).toContain('href="https://www.idanceflow.com/app"');
    expect(html).toMatch(
      new RegExp(`<td bgcolor="${EMAIL_TOKENS.primary}"[^>]*>\\s*<a href="https://www\\.idanceflow\\.com/app"[^>]*color:${EMAIL_TOKENS.white}`),
    );
    expect(html).toContain("Open DanceFlow");
  });
});

describe("studio mode (studio identity leads)", () => {
  it("shows a valid studio logo and no DanceFlow logo", () => {
    const html = renderStudioBrandedEmail({ name: "Acme Dance", logoUrl: LOGO }, base);
    expect(html).toContain(`<img src="${LOGO}" alt=""`);
    expect(html).not.toContain("/brand/logo/");
    expect(html).not.toContain('alt="DanceFlow"');
  });

  it("always shows the studio display name as visible text beside the logo", () => {
    const html = renderStudioBrandedEmail({ name: "Acme Dance", logoUrl: LOGO }, base);
    // Name is a real text cell, not only image alt text, and follows the logo cell.
    expect(html).toMatch(/<img src="[^"]+" alt=""[^>]*\/>\s*<\/td>\s*<td[^>]*>Acme Dance<\/td>/);
  });

  it("caps the logo at 140x48 so the name has room on small screens", () => {
    const html = renderStudioBrandedEmail({ name: "Acme Dance", logoUrl: LOGO }, base);
    expect(html).toContain("max-width:140px;max-height:48px");
    expect(html).not.toContain("max-width:200px");
    expect(html).not.toContain("max-height:56px");
  });

  it("uses the resolved public_name (not the legal name) as the visible name beside the logo", () => {
    const name = resolveStudioDisplayName({ public_name: " Public Studio ", name: "Legal Studio LLC" });
    const html = renderStudioBrandedEmail({ name, logoUrl: LOGO }, base);
    expect(html).toContain(">Public Studio</td>");
    expect(html).not.toContain("Legal Studio LLC");
  });

  it("lets a long name wrap instead of overflowing", () => {
    const html = renderStudioBrandedEmail(
      { name: "The Extraordinarily Long Studio Name Of Dance And Movement", logoUrl: LOGO },
      base,
    );
    expect(html).toContain("overflow-wrap:break-word");
  });

  it("falls back to an initial tile and the name when there is no logo", () => {
    const html = renderStudioBrandedEmail({ name: "Acme Dance", logoUrl: null }, base);
    expect(html).not.toContain("<img");
    expect(html).toContain(`bgcolor="${EMAIL_TOKENS.primarySoft}"`);
    expect(html).toMatch(/line-height:48px;text-align:center;">A<\/td>/);
    expect(html).toContain(">Acme Dance</td>");
  });

  it("resolves public_name before name", () => {
    const name = resolveStudioDisplayName({ public_name: "  Public Studio ", name: "Legal Studio LLC" });
    const html = renderStudioBrandedEmail({ name, logoUrl: null }, base);
    expect(html).toContain("Public Studio");
    expect(html).not.toContain("Legal Studio LLC");
    expect(html).toContain("Sent by Public Studio through DanceFlow");
  });

  it("falls back to name when public_name is blank", () => {
    const name = resolveStudioDisplayName({ public_name: "  ", name: "Legal Studio LLC" });
    expect(renderStudioBrandedEmail({ name, logoUrl: null }, base)).toContain(
      "Sent by Legal Studio LLC through DanceFlow",
    );
  });

  it("never lets DanceFlow stand in as the studio when the name is blank", () => {
    const html = renderStudioBrandedEmail({ name: "   ", logoUrl: null }, base);
    expect(html).toContain("Sent by Your dance studio through DanceFlow");
    expect(html).not.toContain(">DanceFlow</td>");
  });

  it("attributes DanceFlow only as footer text, plus the legal line", () => {
    const html = renderStudioBrandedEmail({ name: "Acme Dance", logoUrl: LOGO }, base);
    expect(html).toContain("Sent by Acme Dance through DanceFlow");
    expect(html).toContain(LEGAL);
    expect(html).not.toContain("This is a system message from DanceFlow.");
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:image/png;base64,AAAA"],
    ["plain http", "http://cdn.example.com/logo.png"],
    ["localhost", "https://localhost/logo.png"],
    ["credentials", "https://user:pw@cdn.example.com/logo.png"],
    ["IP literal", "https://10.0.0.5/logo.png"],
  ])("falls back to the tile when the logo URL is %s", (_label, url) => {
    const html = renderStudioBrandedEmail({ name: "Acme Dance", logoUrl: url }, base);
    expect(html).not.toContain("<img");
    expect(html).not.toContain(url);
    expect(html).toContain(`bgcolor="${EMAIL_TOKENS.primarySoft}"`);
  });

  it("supports explicit test-only insecure fixtures", () => {
    const html = renderBrandedEmail(
      "studio",
      { name: "Acme Dance", logoUrl: "http://localhost:3000/logo.png" },
      base,
      { allowInsecureImageUrls: true },
    );
    expect(html).toContain('<img src="http://localhost:3000/logo.png"');
  });

  it("uses only the approved palette", () => {
    const html = renderStudioBrandedEmail({ name: "Acme Dance", logoUrl: LOGO }, {
      ...base,
      eyebrow: "Studio Update",
      detailRows: [{ label: "When", value: "Tomorrow" }],
      actionLabel: "Open",
      actionUrl: "https://www.idanceflow.com/x",
    });
    for (const hex of hexes(html)) expect(TOKEN_HEXES.has(hex), hex).toBe(true);
    for (const legacy of LEGACY_HEXES) expect(html.toLowerCase()).not.toContain(legacy);
  });
});

describe("organizer mode", () => {
  it("leads with the organizer name and an initial tile, never borrowing a studio logo", () => {
    const html = renderBrandedEmail(
      "organizer",
      { name: "Ballroom Events Co", logoUrl: LOGO },
      base,
    );
    expect(html).not.toContain(LOGO);
    expect(html).not.toContain("<img");
    expect(html).toMatch(/line-height:48px;text-align:center;">B<\/td>/);
    expect(html).toContain(">Ballroom Events Co</td>");
    expect(html).toContain("Sent by Ballroom Events Co through DanceFlow");
    expect(html).toContain(LEGAL);
  });

  it("uses an organizer fallback name rather than a studio or DanceFlow name", () => {
    const html = renderBrandedEmail("organizer", null, base);
    expect(html).toContain("Sent by Your event organizer through DanceFlow");
  });
});

describe("escaping", () => {
  it("escapes hostile identity, heading, detail, note and footer text", () => {
    const hostile = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;
    const html = renderBrandedEmail(
      "studio",
      { name: hostile, logoUrl: null },
      {
        previewText: hostile,
        heading: hostile,
        greeting: hostile,
        intro: hostile,
        bodyText: hostile,
        detailRows: [{ label: hostile, value: hostile }],
        actionLabel: hostile,
        actionUrl: "https://www.idanceflow.com/x",
        footerNote: hostile,
        footerText: hostile,
      },
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("onerror=alert(2)>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps control characters out of the title and preview text", () => {
    const html = renderDanceFlowSystemEmail({
      previewText: "Line one\r\nLine two",
      heading: "Head\r\nline",
      bodyText: "x",
    });
    expect(html).toContain("<title>Head line</title>");
    expect(html).toContain(">Line one Line two</div>");
  });
});

describe("call-to-action and footer compatibility", () => {
  it("drops unsafe or insecure action URLs instead of rendering a button", () => {
    for (const url of ["javascript:alert(1)", "http://www.idanceflow.com/x", "data:text/html,x"]) {
      const html = renderStudioBrandedEmail({ name: "Acme", logoUrl: null }, {
        ...base,
        actionLabel: "Go",
        actionUrl: url,
      });
      expect(html).not.toContain(">Go</a>");
    }
  });

  it("allows an explicit local action URL only through the test option", () => {
    const params = { ...base, actionLabel: "Go", actionUrl: "http://localhost:3000/x" };
    expect(
      renderBrandedEmail("studio", { name: "Acme" }, params, { allowLocalActionUrls: true }),
    ).toContain('href="http://localhost:3000/x"');
    expect(
      renderBrandedEmail("studio", { name: "Acme" }, params, { allowLocalActionUrls: false }),
    ).not.toContain(">Go</a>");
  });

  it("keeps footerText as an attribution override and always appends the legal line", () => {
    const html = renderStudioBrandedEmail({ name: "Acme", logoUrl: null }, {
      ...base,
      footerText: "Sent with DanceFlow.",
    });
    expect(html).toContain("Sent with DanceFlow.");
    expect(html).not.toContain("Sent by Acme through DanceFlow");
    expect(html).toContain(LEGAL);
  });

  it("renders footerNote above the attribution", () => {
    const html = renderStudioBrandedEmail({ name: "Acme", logoUrl: null }, {
      ...base,
      footerNote: "Acme Dance, 1 Main St",
    });
    expect(html.indexOf("Acme Dance, 1 Main St")).toBeGreaterThan(-1);
    expect(html.indexOf("Acme Dance, 1 Main St")).toBeLessThan(
      html.indexOf("Sent by Acme through DanceFlow"),
    );
  });

  it("renders plain-text bodies through the studio shell with the default attribution", () => {
    const html = renderPlainTextAsStudioEmail({
      studioName: "Acme Dance",
      studioLogoUrl: LOGO,
      subject: "Lesson tomorrow",
      bodyText: "See you then.\n\nBring water.",
    });
    expect(html).toContain("Lesson tomorrow");
    expect(html).toContain("See you then.");
    expect(html).toContain("Sent by Acme Dance through DanceFlow");
    expect(html).toContain(LEGAL);
  });
});

describe("responsive and table structure", () => {
  const html = renderBrandedEmail("studio", { name: "Acme", logoUrl: LOGO }, {
    ...base,
    detailRows: [{ label: "When", value: "Tomorrow" }],
  });

  it("caps content width at 660px and never uses a wider fixed width", () => {
    expect(html).toContain("max-width:660px");
    const widths = [...html.matchAll(/\swidth="(\d+)"/g)].map((m) => Number(m[1]));
    for (const w of widths) expect(w).toBeLessThanOrEqual(660);
  });

  it("is table-based with presentation roles and viewport metadata", () => {
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1" />');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="color-scheme" content="light" />');
    expect(html.match(/<table role="presentation"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("includes a modest small-screen rule that stacks detail cells", () => {
    expect(html).toContain("@media only screen and (max-width:480px)");
    expect(html).toContain(".df-stack");
    expect(html).toContain('class="df-stack df-stack-label"');
    expect(html).toContain('class="df-stack df-stack-value"');
  });
});

describe("dedupeBodyLeadIn (BR-3B1, opt-in, default off)", () => {
  const greeting = "Hi Alex,";
  const intro = "Acme Dance approved your lesson request.";
  const rest = "Your appointment has been added to the studio schedule.";
  const params = {
    ...base,
    greeting,
    intro,
    bodyText: [greeting, "", intro, "", rest].join("\n\n"),
    actionLabel: "Open Client Portal",
    actionUrl: "https://www.idanceflow.com/portal/acme-dance",
  };

  it("is off by default: output is byte-identical whether or not the field is present", () => {
    const withoutField = renderStudioBrandedEmail({ name: "Acme Dance", logoUrl: null }, params);
    const explicitlyOff = renderStudioBrandedEmail(
      { name: "Acme Dance", logoUrl: null },
      { ...params, dedupeBodyLeadIn: false },
    );
    expect(explicitlyOff).toBe(withoutField);
    // The duplicated greeting/intro are present when the option is off (today's behavior).
    expect(withoutField.match(new RegExp(greeting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(2);
  });

  it("removes exactly the leading greeting and intro paragraphs when enabled", () => {
    const html = renderStudioBrandedEmail(
      { name: "Acme Dance", logoUrl: null },
      { ...params, dedupeBodyLeadIn: true },
    );
    expect(html.match(new RegExp(greeting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
    expect(html.match(new RegExp(intro.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
    expect(html).toContain(rest);
  });

  it("removes a trailing CTA URL line matching the rendered action URL", () => {
    const url = "https://www.idanceflow.com/app/schedule";
    const html = renderStudioBrandedEmail(
      { name: "Acme Dance", logoUrl: null },
      {
        ...base,
        greeting,
        intro,
        bodyText: [greeting, "", intro, "", `Open Schedule: ${url}`].join("\n\n"),
        actionLabel: "Open Schedule",
        actionUrl: url,
        dedupeBodyLeadIn: true,
      },
    );
    // The URL appears once, in the CTA button, not again as a body line.
    expect(html.match(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
  });

  it("leaves text that does not exactly match the greeting/intro alone (no heuristic rewriting)", () => {
    const html = renderStudioBrandedEmail(
      { name: "Acme Dance", logoUrl: null },
      {
        ...base,
        greeting,
        intro,
        bodyText: ["A different opening line.", "", "More body text."].join("\n\n"),
        dedupeBodyLeadIn: true,
      },
    );
    expect(html).toContain("A different opening line.");
    expect(html).toContain("More body text.");
  });

  it("never modifies the plain-text body", () => {
    const html1 = renderStudioBrandedEmail({ name: "Acme Dance", logoUrl: null }, { ...params, dedupeBodyLeadIn: true });
    const html2 = renderStudioBrandedEmail({ name: "Acme Dance", logoUrl: null }, { ...params, dedupeBodyLeadIn: false });
    // bodyText itself is a function input, not shell output; assert the helper is pure and side-effect free.
    expect(params.bodyText).toContain(greeting);
    expect(html1).not.toBe(html2);
  });

  it("stripBodyLeadIn is exact-match only and returns the original text unchanged when nothing matches", () => {
    const text = ["Something else entirely.", "", "More."].join("\n\n");
    expect(stripBodyLeadIn(text, { greeting, intro })).toBe(text);
    expect(
      stripBodyLeadIn([greeting, "", intro, "", "Body."].join("\n\n"), { greeting, intro }),
    ).toBe("Body.");
  });
});

describe("BR-3C/BR-3E characterization (must not change without opting in)", () => {
  it("system mode renders identically with no dedupe option present", () => {
    const html = renderDanceFlowSystemEmail({
      ...base,
      greeting: "Hi Jordan,",
      intro: "Your studio workspace is ready.",
    });
    expect(html.match(/Hi Jordan,/g)?.length).toBe(1);
    expect(html).toContain("Your studio workspace is ready.");
  });

  it("organizer mode is unaffected by the studio-mode dedupe option", () => {
    const html = renderBrandedEmail(
      "organizer",
      { name: "Ballroom Events Co" },
      { ...base, greeting: "Hi Morgan,", intro: "You are registered.", bodyText: "Hi Morgan,\n\nYou are registered.\n\nMore." },
    );
    expect(html.match(/Hi Morgan,/g)?.length).toBe(2);
  });
});

describe("public API compatibility", () => {
  it("keeps the three original exports callable with unchanged shapes", () => {
    expect(typeof renderDanceFlowSystemEmail).toBe("function");
    expect(typeof renderStudioBrandedEmail).toBe("function");
    expect(typeof renderPlainTextAsStudioEmail).toBe("function");
    expect(renderDanceFlowSystemEmail(base)).toBe(renderBrandedEmail("system", null, base));
    expect(renderStudioBrandedEmail({ name: "A", logoUrl: LOGO }, base)).toBe(
      renderBrandedEmail("studio", { name: "A", logoUrl: LOGO }, base),
    );
  });
});

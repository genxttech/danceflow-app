import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { EMAIL_LOGO_FILES, EMAIL_TOKENS } from "@/lib/email/brand";

/**
 * BR-3A guards: the shared email brand module and shell stay on the approved palette and canonical assets,
 * the retired logo stays retired, escape helpers do not multiply, and the subject sanitizer stays wired
 * at the three approved send chokepoints.
 */
const ROOT = process.cwd();
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function sourceFiles() {
  return walk(join(ROOT, "src")).filter(
    (f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__") && !/\.test\.tsx?$/.test(f),
  );
}

const SHELL_FILES = ["src/lib/email/brand.ts", "src/lib/notifications/email-branding.ts"];
const TOKEN_HEXES = new Set(Object.values(EMAIL_TOKENS).map((h) => h.toLowerCase()));

describe("retired logo", () => {
  it("is not referenced by email, notification, document or API source", () => {
    const dirs = ["lib/email", "lib/notifications", "lib/documents", "app/api"].map((d) =>
      join(ROOT, "src", d),
    );
    const offenders = dirs
      .flatMap((d) => (existsSync(d) ? walk(d) : []))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__"))
      .filter((f) => /danceflow-logo\.png/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  }, 60_000);
});

describe("canonical logo files", () => {
  it("exist for every approved asset name", () => {
    for (const file of Object.values(EMAIL_LOGO_FILES)) {
      expect(existsSync(join(ROOT, "public", "brand", "logo", file)), file).toBe(true);
    }
  });

  it("include the approved white primary logo used by the system header", () => {
    expect(EMAIL_LOGO_FILES["primary-white"]).toBe("danceflow-logo-primary-white.png");
  });
});

describe("shared shell and brand module", () => {
  it.each(SHELL_FILES)("%s contains only approved email palette hex values", (file) => {
    const source = read(...file.split("/"));
    const found = (source.match(/(?<![&\w])#[0-9a-fA-F]{3,8}\b/g) ?? []).map((h) => h.toLowerCase());
    for (const hex of found) expect(TOKEN_HEXES.has(hex), `${file}: ${hex}`).toBe(true);
  });

  it.each(SHELL_FILES)("%s has no legacy email colours, web fonts or retired lockups", (file) => {
    const source = read(...file.split("/"));
    for (const legacy of ["#4c1d95", "#2e1065", "#1e1b4b", "#f97316", "#be185d", "#f5f3f7", "#0f172a"]) {
      expect(source.toLowerCase()).not.toContain(legacy);
    }
    expect(source).not.toMatch(/@font-face|@import|fonts\.googleapis|\bSora\b|\bInter\b/);
    expect(source).not.toMatch(/studio operating system|logo-compact|logo-descriptor/i);
  });

  it("keeps the legal line in exactly one email presentation module", () => {
    const holders = sourceFiles()
      .filter((f) => /lib\/(email|notifications)\//.test(rel(f)))
      .filter((f) => readFileSync(f, "utf8").includes("GenX TotalTech LLC"))
      .map(rel);
    expect(holders).toEqual(["src/lib/email/brand.ts"]);
  });
});

describe("escapeHtml ratchet", () => {
  // Existing duplicates that later BR-3 slices remove. This list may only shrink.
  const KNOWN_DUPLICATES = [
    "src/app/api/cron/aria-digest/route.ts",
    "src/app/api/platform/daily-digest/route.ts",
    "src/app/app/clients/[id]/actions.ts",
    "src/app/app/documents/actions.ts",
    // BR-3B2: src/app/app/documents/sign/actions.ts migrated onto the shared shell and its local
    // duplicate escapeHtml became genuinely unused, so it was removed -- shrinking this list.
    "src/app/app/marketing/campaigns/[id]/actions.ts",
    "src/app/app/marketing/campaigns/actions.ts",
    "src/app/app/organizer-campaigns/[id]/actions.ts",
    // Not email code: a browser script held in a string (the escape helper is inside the string literal).
    "src/app/embed/events.js/route.ts",
    "src/app/platform/invites/actions.ts",
    "src/lib/documents/operations.ts",
    "src/lib/notifications/dispatch.ts",
    "src/lib/notifications/templates.ts",
    "src/lib/student-identity/account-data.ts",
  ];

  const DEFINITION = /(?:function|const)\s+(?:escapeHtml|htmlEscape|escapeHTML)\b\s*(?:\(|=)/;

  it("adds no new duplicate escape helper beyond the known list", () => {
    const definers = sourceFiles()
      .filter((f) => !rel(f).endsWith("src/lib/email/brand.ts"))
      .filter((f) => DEFINITION.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    const unexpected = definers.filter((f) => !KNOWN_DUPLICATES.includes(f));
    expect(unexpected).toEqual([]);
  }, 60_000);

  it("keeps a single definition in the shared brand module and none in the shell", () => {
    const brand = read("src", "lib", "email", "brand.ts");
    expect(brand.match(/export function escapeHtml\b/g)?.length).toBe(1);
    expect(DEFINITION.test(read("src", "lib", "notifications", "email-branding.ts"))).toBe(false);
  });
});

describe("BR-3B1 base-URL normalization", () => {
  // Files migrated in BR-3B1: no more hard-coded idanceflow.com fallbacks or NEXT_PUBLIC_SITE_URL/APP_URL reads.
  const MIGRATED_FILES = [
    "src/lib/notifications/scheduling-emails.ts",
    "src/lib/notifications/notification-html.ts",
    "src/lib/schedule/appointmentConfirmation.ts",
    "src/lib/commerce/studentMarketplace.ts",
    "src/lib/accountant-deliveries/deliveries.ts",
    "src/app/book/[studioSlug]/actions.ts",
    "src/app/portal/[studioSlug]/schedule/actions.ts",
    "src/app/app/schedule/requests/actions.ts",
    "src/app/api/notifications/send/route.ts",
  ];

  it.each(MIGRATED_FILES)("%s has no hard-coded idanceflow.com fallback or raw site/app URL env read", (file) => {
    const source = read(...file.split("/"));
    expect(source).not.toMatch(/https:\/\/(www\.)?idanceflow\.com/);
    expect(source).not.toMatch(/NEXT_PUBLIC_SITE_URL|NEXT_PUBLIC_APP_URL/);
  });
});

describe("BR-3B2 base-URL normalization", () => {
  // Files migrated in BR-3B2: no more hard-coded idanceflow.com fallbacks or raw NEXT_PUBLIC_SITE_URL/
  // NEXT_PUBLIC_APP_URL reads for customer-facing links.
  const MIGRATED_FILES = [
    "src/app/sign/[token]/actions.ts",
    "src/app/app/documents/sign/actions.ts",
    "src/app/app/documents/actions.ts",
    "src/lib/documents/operations.ts",
  ];

  it.each(MIGRATED_FILES)("%s has no hard-coded idanceflow.com fallback or raw site/app URL env read", (file) => {
    const source = read(...file.split("/"));
    expect(source).not.toMatch(/https:\/\/(www\.)?idanceflow\.com/);
    expect(source).not.toMatch(/NEXT_PUBLIC_SITE_URL|NEXT_PUBLIC_APP_URL/);
  });

  it("the direct portal invite path deliberately keeps a raw base-URL read for the auth callback/redirect only", () => {
    // Not migrated to buildAppUrl: the magic-link redirect must resolve to whatever origin this
    // request's Supabase auth session actually validates against, not the canonical marketing/email
    // origin. Only the plain, non-auth portal link in this file is canonicalized via buildAppUrl.
    const source = read("src", "app", "app", "clients", "[id]", "actions.ts");
    expect(source).toContain("const portalUrl = buildAppUrl(portalPath);");
    expect(source).toMatch(/NEXT_PUBLIC_SITE_URL|NEXT_PUBLIC_APP_URL/);
  });
});

describe("dedupeBodyLeadIn stays opt-in and scoped to BR-3B1", () => {
  // BR-3C/BR-3E callers must not opt in without an explicit later decision.
  const MUST_NOT_OPT_IN = [
    "src/lib/notifications/templates.ts",
    "src/app/api/cron/aria-digest/route.ts",
    "src/app/platform/invites/actions.ts",
    "src/app/app/marketing/campaigns/actions.ts",
    "src/app/app/organizer-campaigns/[id]/actions.ts",
  ];

  it.each(MUST_NOT_OPT_IN)("%s does not opt into dedupeBodyLeadIn", (file) => {
    if (!existsSync(join(ROOT, ...file.split("/")))) return;
    expect(read(...file.split("/"))).not.toMatch(/dedupeBodyLeadIn/);
  });

  it("the welcome/system email path in dispatch.ts does not opt in", () => {
    const dispatch = read("src", "lib", "notifications", "dispatch.ts");
    expect(dispatch).not.toMatch(/dedupeBodyLeadIn/);
  });
});

describe("subject sanitizer chokepoints", () => {
  it("wraps the welcome send and the queued send in dispatch.ts", () => {
    const dispatch = read("src", "lib", "notifications", "dispatch.ts").replace(/\r\n/g, "\n");
    expect(dispatch).toContain('import { sanitizeEmailSubject } from "@/lib/email/brand";');
    const sends = dispatch.match(
      /resend\.emails\.send\(\{[^}]*?subject: sanitizeEmailSubject\(rendered\.subject\)/g,
    );
    expect(sends?.length).toBe(2);
    expect(dispatch).not.toMatch(/resend\.emails\.send\(\{[^}]*?\n\s*subject: rendered\.subject,/);
  });

  it("wraps the notification send route", () => {
    const route = read("src", "app", "api", "notifications", "send", "route.ts").replace(/\r\n/g, "\n");
    expect(route).toContain('import { sanitizeEmailSubject } from "@/lib/email/brand";');
    expect(route).toContain("subject: sanitizeEmailSubject(params.subject),");
    expect(route).not.toContain("subject: params.subject,");
  });

  it("wraps both live studio-campaign send sites (BR-3B2)", () => {
    const campaigns = read("src", "app", "app", "marketing", "campaigns", "actions.ts").replace(/\r\n/g, "\n");
    expect(campaigns).toContain('import { resolveStudioDisplayName, sanitizeEmailSubject } from "@/lib/email/brand";');
    expect(campaigns).toMatch(/const subject = sanitizeEmailSubject\(`\[TEST\] \$\{campaign\.subject\}`\);/);
    expect(campaigns).toMatch(/const subject = sanitizeEmailSubject\(campaign\.subject\);/);
    // Neither live send call passes the raw, unsanitized campaign.subject to Resend.
    const sendCalls = campaigns.match(/resend\.emails\.send\(\{[^}]*\}\)/g) ?? [];
    expect(sendCalls.length).toBe(2);
    for (const call of sendCalls) {
      expect(call).not.toMatch(/subject:\s*campaign\.subject/);
    }
  });
});

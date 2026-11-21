import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { knowledgebaseRedirects } from "@/content/knowledgebase/redirects";
import { loadKnowledgebaseArticlesFrom } from "../loader";
import { parseArticleMarkdown, type Block, type InlineNode } from "../markdown";
import { validateKnowledgebaseRedirects } from "../redirects";

/**
 * KB-2B content-integrity tests. They run against the real article files, so a broken slug, link, reference
 * or frontmatter field fails CI before it reaches the public site.
 */

const ROOT = process.cwd();
const ARTICLES_DIR = path.join(ROOT, "src", "content", "knowledgebase", "articles");
const { articles, errors } = loadKnowledgebaseArticlesFrom(ARTICLES_DIR);
const liveSlugs = new Set(articles.map((a) => a.slug));
const resolvesToLive = (slug: string) => liveSlugs.has(slug) || liveSlugs.has(knowledgebaseRedirects[slug] ?? "");

/** The 79 slugs published when KB-2B migrated the content. A slug may only leave this list by gaining a redirect. */
const MIGRATED_SLUGS = [
  "adding-an-event-schedule-or-agenda",
  "approving-or-declining-booking-requests",
  "aria-automation-center-and-operations",
  "aria-autonomy-and-safety",
  "aria-operations-expanded-setup",
  "aria-operations-quick-start",
  "billing-payments-and-payouts",
  "booking-availability-rules",
  "branded-portal-invite-emails",
  "checking-in-event-attendees",
  "choosing-the-right-lesson-billing-type",
  "client-photo-verification",
  "client-portal-linking-invites-vs-existing-accounts",
  "collecting-in-person-card-payments-in-danceflow",
  "connecting-google-calendar",
  "creating-a-marketing-campaign",
  "creating-multi-location-multi-date-events",
  "current-danceflow-capabilities",
  "dashboard-alerts-and-announcements",
  "documents-and-e-signatures",
  "duplicating-an-event",
  "event-profitability-and-closeout-review",
  "finding-signed-documents-and-waivers",
  "getting-started-checklist-for-studios",
  "getting-started-with-organizer-workspace",
  "how-danceflow-protects-your-data",
  "importing-client-data-from-a-csv",
  "in-person-payment-options-and-reader-requirements",
  "independent-instructors-and-host-studio-rentals",
  "making-your-studio-visible-in-public-discovery",
  "manage-guest-coach-lesson-slots",
  "managing-booking-requests",
  "managing-daily-closeout-and-lessons-that-need-review",
  "managing-event-tickets-and-registrations",
  "moving-to-danceflow-with-the-migration-center",
  "organizer-contacts-and-event-audiences",
  "packages-vs-memberships",
  "portal-schedule-requests",
  "preparing-instructor-payroll",
  "privacy-security-and-student-data-basics",
  "registering-a-stripe-card-reader",
  "resend-event-ticket-confirmation",
  "resetting-your-password",
  "review-event-registration-payment-status",
  "selling-guest-coach-private-lesson-slots",
  "selling-tickets-from-admin-side",
  "sending-secure-reports-to-your-accountant",
  "setting-up-accountant-report-delivery",
  "setting-up-intro-lesson-requests",
  "setting-up-team-members-and-front-desk-access",
  "setting-up-your-public-studio-profile",
  "sms-consent-and-message-history",
  "sms-opt-in-for-studios",
  "staff-credential-verification",
  "staff-photos-and-credentials",
  "student-portal-access-and-sign-in-links",
  "syncing-instructor-schedule-to-calendar",
  "taking-in-person-payments-with-tap-to-pay",
  "troubleshooting-client-portal-invite-emails",
  "turning-event-registrations-into-crm-leads",
  "understanding-basic-profit-and-loss-reports",
  "understanding-marketing-audiences",
  "understanding-public-event-pages-and-the-event-cart",
  "using-aria-revenue-insights",
  "using-automations-for-client-follow-up",
  "using-client-account-credits-and-balances",
  "using-client-identity-and-qr-verification",
  "using-danceflow-events-on-your-website-calendar",
  "using-early-bird-ticket-pricing",
  "using-event-qr-tickets-and-scan-check-in",
  "using-event-waivers-and-e-signatures",
  "using-expenses-and-floor-fee-expense-tracking",
  "using-partner-search",
  "using-share-buttons-for-studios-and-events",
  "using-the-student-portal",
  "using-the-workspace-setup-checklist",
  "verified-staff-credentials-on-public-pages",
  "what-is-danceflow",
  "why-my-studio-or-events-do-not-appear-in-public-discovery",
];

describe("article files", () => {
  it("all load and satisfy the frontmatter schema, unique slugs and orders, and related references", () => {
    expect(errors).toEqual([]);
  });

  it("every file name is its slug (so a slug cannot change without moving the file)", () => {
    const files = fs.readdirSync(ARTICLES_DIR).sort();
    expect(files).toEqual([...liveSlugs].sort().map((slug) => `${slug}.md`));
  });

  it("every article has a summary and a body with content", () => {
    for (const article of articles) {
      expect(article.summary.length, article.slug).toBeGreaterThan(20);
      expect(article.content.length, article.slug).toBeGreaterThan(100);
    }
  });

  it("contexts stay empty until KB-4 maps pages to articles", () => {
    expect(articles.filter((a) => a.contexts.length > 0)).toEqual([]);
  });
});

describe("slug contract", () => {
  it("no migrated slug disappears without a redirect to a live article", () => {
    expect(MIGRATED_SLUGS.filter((slug) => !resolvesToLive(slug))).toEqual([]);
  });

  it("the redirect map is valid: no live sources, no dangling targets, no chains, no loops", () => {
    expect(validateKnowledgebaseRedirects(knowledgebaseRedirects, liveSlugs)).toEqual([]);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("links into the knowledgebase from the rest of the product", () => {
  const sourceRoots = [
    path.join(ROOT, "src"),
    path.join(ROOT, "mobile", "student", "src"),
    path.join(ROOT, "mobile", "student", "app"),
    path.join(ROOT, "mobile", "business", "src"),
    path.join(ROOT, "mobile", "business", "app"),
  ].filter((p) => fs.existsSync(p));
  const files = sourceRoots
    .flatMap((root) => walk(root))
    .filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`) && !/\.test\.tsx?$/.test(f));
  const linked = new Map<string, string[]>();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?<!\/lib|\/components|\/content)\/knowledgebase\/([a-z0-9][a-z0-9-]*)/g)) {
      linked.set(match[1], [...(linked.get(match[1]) ?? []), path.relative(ROOT, file)]);
    }
  }

  it("finds the welcome email's article links (guards the scan itself)", () => {
    expect([...linked.keys()]).toContain("getting-started-checklist-for-studios");
  });

  it("every article slug linked from app, email or mobile source resolves to a live article or a redirect", () => {
    const dead = [...linked.entries()]
      .filter(([slug]) => !resolvesToLive(slug))
      .map(([slug, from]) => `${slug} (in ${[...new Set(from)].join(", ")})`);
    expect(dead).toEqual([]);
  });
});

function routeExists(segments: string[], dir = path.join(ROOT, "src", "app")): boolean {
  if (segments.length === 0) return fs.existsSync(path.join(dir, "page.tsx")) || fs.existsSync(path.join(dir, "route.ts"));
  const [head, ...rest] = segments;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const next = path.join(dir, entry.name);
    if (/^\(.+\)$/.test(entry.name)) {
      if (routeExists(segments, next)) return true;
    } else if (/^\[\.\.\.[^\]]+\]$/.test(entry.name) || /^\[\[\.\.\.[^\]]+\]\]$/.test(entry.name)) {
      return true;
    } else if (entry.name === head || /^\[[^\]]+\]$/.test(entry.name)) {
      if (routeExists(rest, next)) return true;
    }
  }
  return false;
}

function collectInlines(block: Block): InlineNode[] {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return block.inlines;
    case "ul":
    case "ol":
      return block.items.flat();
    case "table":
      return [...block.header.flat(), ...block.rows.flat(2)];
    case "callout":
      return block.lines.flat();
    default:
      return [];
  }
}

describe("links and images inside article bodies", () => {
  const parsed = articles.map((a) => ({ slug: a.slug, blocks: parseArticleMarkdown(a.content) }));

  it("internal links resolve to a live article, a public file or a real route", () => {
    const broken: string[] = [];
    for (const { slug, blocks } of parsed) {
      for (const node of blocks.flatMap(collectInlines)) {
        if (node.type !== "link" || node.kind === "external") continue;
        const href = node.href.split(/[?#]/)[0];
        const article = /^\/knowledgebase\/([^/]+)$/.exec(href);
        if (article) {
          if (!resolvesToLive(article[1])) broken.push(`${slug}: ${node.href}`);
        } else if (node.kind === "file") {
          if (!fs.existsSync(path.join(ROOT, "public", href))) broken.push(`${slug}: ${node.href} (no such file in public/)`);
        } else if (href !== "/knowledgebase" && !routeExists(href.split("/").filter(Boolean))) {
          broken.push(`${slug}: ${node.href} (no such route)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("images exist in public/ and carry alt text", () => {
    const broken: string[] = [];
    for (const { slug, blocks } of parsed) {
      for (const block of blocks) {
        if (block.type !== "image") continue;
        if (block.alt.trim() === "") broken.push(`${slug}: image ${block.src} has no alt text`);
        if (block.src.startsWith("/") && !fs.existsSync(path.join(ROOT, "public", block.src))) {
          broken.push(`${slug}: ${block.src} is not in public/`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("a link written with a bad or unsafe target does not survive as literal markdown text", () => {
    const stray: string[] = [];
    for (const { slug, blocks } of parsed) {
      for (const node of blocks.flatMap(collectInlines)) {
        if (node.type === "text" && /\]\(/.test(node.text)) stray.push(`${slug}: ${node.text.slice(0, 60)}`);
      }
    }
    expect(stray).toEqual([]);
  });
});

describe("vocabulary guard (extends BR-4C to the article files)", () => {
  /**
   * Retired product names must not spread. Where an article still contains one today (KB-2A fixes these),
   * it is listed in `allowedIn`; the list may shrink but must not grow.
   */
  const RETIRED: Array<{ term: RegExp; label: string; allowedIn: string[] }> = [
    { term: /DanceFlow Organizer Workspace/, label: "DanceFlow Organizer Workspace", allowedIn: [] },
    { term: /Getting Started with Your Organizer Workspace/, label: "old organizer article title", allowedIn: [] },
    { term: /DanceFlow Studio Workspace/, label: "DanceFlow Studio Workspace", allowedIn: [] },
    { term: /DanceFlow Discovery/, label: "DanceFlow Discovery (now Discover)", allowedIn: ["getting-started-checklist-for-studios"] },
    {
      term: /(?<!host )studio portals?/i,
      label: "Studio Portal (the dancer-facing portal is Student Portal)",
      allowedIn: [
        "what-is-danceflow",
        "client-portal-linking-invites-vs-existing-accounts",
        "branded-portal-invite-emails",
        "using-the-student-portal",
        "student-portal-access-and-sign-in-links",
      ],
    },
  ];

  it.each(RETIRED.map((r) => [r.label, r] as const))("%s appears only where it already did", (_label, rule) => {
    const offenders = articles.filter((a) => rule.term.test(`${a.title}\n${a.summary}\n${a.content}`)).map((a) => a.slug);
    expect(offenders.filter((slug) => !rule.allowedIn.includes(slug))).toEqual([]);
  });

  it("the organizer article keeps its Organizer Suite title (slug unchanged so links keep working)", () => {
    const article = articles.find((a) => a.slug === "getting-started-with-organizer-workspace");
    expect(article?.title).toBe("Getting Started with Organizer Suite");
  });

  it("article copy carries no AI attribution or tooling footer", () => {
    for (const a of articles) {
      expect(a.content, a.slug).not.toMatch(/Co-Authored-By|Generated with|Claude Code/i);
    }
  });
});

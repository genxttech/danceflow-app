import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ArticleBody from "@/components/knowledgebase/ArticleBody";
import { getKnowledgebaseArticles } from "../articles";

const knowledgebaseArticles = getKnowledgebaseArticles();
import { classifyHref, parseArticleMarkdown, parseInline, slugifyHeading } from "../markdown";

const html = (markdown: string) => renderToStaticMarkup(createElement(ArticleBody, { markdown }));

describe("parseArticleMarkdown", () => {
  it("keeps the original line-per-paragraph behavior and the original heading, bullet and bold forms", () => {
    const blocks = parseArticleMarkdown("## Overview\n\nOne line.\nSecond line.\n\n- a\n- **b**\n\nEnd");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "paragraph", "ul", "paragraph"]);
    expect(blocks[3]).toMatchObject({ type: "ul", items: [[{ type: "text", text: "a" }], [{ type: "strong", text: "b" }]] });
  });

  it("builds real ordered lists, keeping the first number as the start", () => {
    const [list] = parseArticleMarkdown("3. Three\n4. Four");
    expect(list).toMatchObject({ type: "ol", start: 3 });
    expect(html("1. One\n2. Two")).toContain('<ol start="1"');
    expect(html("1. One\n2. Two")).not.toContain("<p");
  });

  it("supports h3 and h4 and never emits a second h1", () => {
    const out = html("# Top\n\n## Two\n\n### Three\n\n#### Four");
    expect(out).not.toContain("<h1");
    expect(out).toContain("<h3");
    expect(out).toContain("<h4");
    expect(out).not.toContain("###");
  });

  it("gives headings stable, unique anchor ids", () => {
    const out = html("## Best practice\n\n## Best practice\n\n## What's new & fixed?");
    expect(out).toContain('id="best-practice"');
    expect(out).toContain('id="best-practice-2"');
    expect(out).toContain('id="what-s-new-and-fixed"');
    expect(slugifyHeading("!!!")).toBe("section");
  });

  it("renders tables with header cells scoped to columns and pads short rows", () => {
    const out = html("| Action | Best For |\n|---|---|\n| Invite | New clients |\n| Link |");
    expect(out).toContain('<th scope="col"');
    expect(out).toContain("<table");
    expect(out).not.toContain("|---|");
    expect(out.match(/<td/g)).toHaveLength(4);
  });

  it("does not treat a lone pipe line as a table", () => {
    expect(parseArticleMarkdown("| not a table").map((b) => b.type)).toEqual(["paragraph"]);
  });

  it("renders callouts as notes with a style per label", () => {
    const out = html("> **Warning:** Do not do this.\n> Second line.\n\n> **Prerequisite:** Growth plan.\n\n> plain quote");
    expect(out).toContain('data-callout="warning"');
    expect(out).toContain('data-callout="prerequisite"');
    expect(out).toContain('data-callout="note"');
    expect(out).toContain('role="note"');
  });

  it("renders images from local paths or https with their alt text, and refuses other sources", () => {
    expect(html("![A calendar](/kb/calendar.png)")).toContain('alt="A calendar"');
    expect(html("![x](javascript:alert(1))")).not.toContain("<img");
    expect(html("![x](//evil.example/a.png)")).not.toContain("<img");
  });
});

describe("inline formatting and links", () => {
  it("renders inline code and bold", () => {
    expect(parseInline("Use `.ics` and **bold**")).toEqual([
      { type: "text", text: "Use " },
      { type: "code", text: ".ics" },
      { type: "text", text: " and " },
      { type: "strong", text: "bold" },
    ]);
  });

  it("renders internal, file and external links as real anchors", () => {
    const out = html("[Guide](/knowledgebase/x) [PDF](/guides/a.pdf) [Out](https://example.com/a) [Mail](mailto:a@b.co)");
    expect(out).toContain('href="/knowledgebase/x"');
    expect(out).toContain('href="/guides/a.pdf"');
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('href="mailto:a@b.co"');
  });

  it("never turns an unsafe link into an anchor", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "http://plain.example", "vbscript:x", "relative/path"]) {
      expect(classifyHref(href)).toBeNull();
      const out = html(`[x](${href})`);
      expect(out).not.toContain("<a ");
    }
  });

  it("escapes markup in article text", () => {
    const out = html("<script>alert(1)</script> and **<b>x</b>**");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("the current 79 articles", () => {
  const rendered = knowledgebaseArticles.map((a) => ({
    slug: a.slug,
    out: html(a.content),
    blocks: parseArticleMarkdown(a.content),
  }));

  it("leaves no raw markdown behind (the KB-1 section 1.2 defects)", () => {
    for (const { slug, out } of rendered) {
      expect(out, `${slug}: literal ###`).not.toMatch(/(^|>)\s*###/);
      expect(out, `${slug}: raw table`).not.toContain("|---|");
      expect(out, `${slug}: literal markdown link`).not.toMatch(/\[[^\]]+\]\(\//);
      expect(out, `${slug}: stray bold markers`).not.toContain("**");
      expect(out, `${slug}: h1 in body`).not.toContain("<h1");
    }
  });

  it("renders the 144 numbered steps as ordered lists, the 24 h3 headings, one table and two file links", () => {
    const all = rendered.flatMap((r) => r.blocks);
    let steps = 0;
    for (const block of all) if (block.type === "ol") steps += block.items.length;
    expect(steps).toBe(144);
    expect(all.filter((b) => b.type === "heading" && b.level === 3)).toHaveLength(24);
    expect(all.filter((b) => b.type === "table")).toHaveLength(1);
    const links = rendered.reduce((n, r) => n + (r.out.match(/href="\/guides\/[^"]+\.pdf"/g)?.length ?? 0), 0);
    expect(links).toBe(2);
  });

  it("keeps every heading id unique within an article", () => {
    for (const { slug, out } of rendered) {
      const ids = [...out.matchAll(/<h[2-4] id="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size, slug).toBe(ids.length);
    }
  });
});

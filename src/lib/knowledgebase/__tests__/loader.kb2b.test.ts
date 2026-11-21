import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadKnowledgebaseArticlesFrom, loadKnowledgebaseArticlesOrThrow } from "../loader";
import { resolveKnowledgebaseSlug, validateKnowledgebaseRedirects } from "../redirects";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb2b-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function article(slug: string, order: number, extra = "", body = "Some text.") {
  fs.writeFileSync(
    path.join(dir, `${slug}.md`),
    `---\ntitle: "T ${slug}"\nslug: ${slug}\ncategory: Cat\nsummary: "S ${slug}"\norder: ${order}\n${extra}---\n\n${body}\n`,
  );
}

describe("loadKnowledgebaseArticlesFrom", () => {
  it("returns articles sorted by order, regardless of file name", () => {
    article("zeta", 10);
    article("alpha", 30);
    article("mid", 20);
    const { articles, errors } = loadKnowledgebaseArticlesFrom(dir);
    expect(errors).toEqual([]);
    expect(articles.map((a) => a.slug)).toEqual(["zeta", "mid", "alpha"]);
    expect(articles[0].content).toBe("Some text.");
  });

  it("reports every problem at once", () => {
    article("one", 10, "related: [ghost]\n");
    article("two", 10);
    fs.writeFileSync(path.join(dir, "wrong-name.md"), `---\ntitle: "x"\nslug: other\ncategory: C\nsummary: "s"\norder: 5\n---\nBody\n`);
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    fs.writeFileSync(path.join(dir, "broken.md"), "no frontmatter");
    article("empty", 40, "", "");
    const { errors } = loadKnowledgebaseArticlesFrom(dir);
    const text = errors.join("\n");
    expect(text).toMatch(/related slug "ghost" does not exist/);
    expect(text).toMatch(/share order 10/);
    expect(text).toMatch(/file name must be "other.md"/);
    expect(text).toMatch(/only .md article files/);
    expect(text).toMatch(/broken.md: file must start with/);
    expect(text).toMatch(/empty.md: article body is empty/);
  });

  it("flags related links to drafts and from public to signed-in articles", () => {
    article("pub", 10, "related: [draft-one, private-one]\n");
    article("draft-one", 20, "status: draft\n");
    article("private-one", 30, "visibility: signed_in\n");
    const text = loadKnowledgebaseArticlesFrom(dir).errors.join("\n");
    expect(text).toMatch(/"draft-one" is not published/);
    expect(text).toMatch(/must not relate to the signed-in article "private-one"/);
  });

  it("throws one readable error from the runtime wrapper", () => {
    article("one", 10, "related: [ghost]\n");
    expect(() => loadKnowledgebaseArticlesOrThrow(dir)).toThrow(/Knowledgebase content is invalid/);
  });
});

describe("retired slug redirects", () => {
  const live = new Set(["current", "other"]);

  it("serves a live slug, redirects a retired slug, and 404s anything else", () => {
    const redirects = { "old-name": "current" };
    expect(resolveKnowledgebaseSlug("current", live, redirects)).toEqual({ kind: "article", slug: "current" });
    expect(resolveKnowledgebaseSlug("old-name", live, redirects)).toEqual({ kind: "redirect", slug: "current" });
    expect(resolveKnowledgebaseSlug("never-existed", live, redirects)).toEqual({ kind: "missing" });
    expect(resolveKnowledgebaseSlug("constructor", live, redirects)).toEqual({ kind: "missing" });
  });

  it("never redirects to a target that is not live", () => {
    expect(resolveKnowledgebaseSlug("old", live, { old: "gone" })).toEqual({ kind: "missing" });
  });

  it("accepts a valid map and an empty map", () => {
    expect(validateKnowledgebaseRedirects({}, live)).toEqual([]);
    expect(validateKnowledgebaseRedirects({ old: "current" }, live)).toEqual([]);
  });

  it("rejects self redirects, live sources, dangling targets and chains", () => {
    const text = validateKnowledgebaseRedirects(
      { loop: "loop", current: "other", a: "missing", b: "c", c: "current" },
      live,
    ).join("\n");
    expect(text).toMatch(/"loop" points at itself/);
    expect(text).toMatch(/"current" is still a live article/);
    expect(text).toMatch(/"a" -> "missing": target is not a live article/);
    expect(text).toMatch(/"b" -> "c" is a chain/);
  });
});

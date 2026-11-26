import { describe, expect, it } from "vitest";
import { FrontmatterError, formatScalar, parseFrontmatter } from "../frontmatter";
import { validateFrontmatter } from "../schema";

const doc = (head: string, body = "Body text.\n") => `---\n${head}\n---\n${body}`;

describe("parseFrontmatter", () => {
  it("reads scalars, numbers, lists and a one-level map, and returns the body", () => {
    const { data, body } = parseFrontmatter(
      doc(
        [
          'title: "Why: colons and \\"quotes\\""',
          "slug: how-to",
          "order: 20",
          "roles: [owner, admin]",
          "related: []",
          "requires:",
          "  plan: growth",
          '  flags: [A_FLAG, "B_FLAG"]',
          "summary: 'It''s fine'",
        ].join("\n"),
        "\n# Heading\n\nText\n",
      ),
      "x.md",
    );
    expect(data).toEqual({
      title: 'Why: colons and "quotes"',
      slug: "how-to",
      order: 20,
      roles: ["owner", "admin"],
      related: [],
      requires: { plan: "growth", flags: ["A_FLAG", "B_FLAG"] },
      summary: "It's fine",
    });
    expect(body).toBe("\n# Heading\n\nText\n");
  });

  it("accepts CRLF files and a byte-order mark", () => {
    const { data, body } = parseFrontmatter("﻿---\r\ntitle: A\r\n---\r\nLine\r\n", "x.md");
    expect(data).toEqual({ title: "A" });
    expect(body).toBe("Line\n");
  });

  it("round-trips what formatScalar writes", () => {
    const tricky = 'He said "hi": it\'s 100% [fine], # not a comment';
    const { data } = parseFrontmatter(doc(`title: ${formatScalar(tricky)}`), "x.md");
    expect(data.title).toBe(tricky);
  });

  it.each([
    ["no frontmatter", "Just text\n"],
    ["unclosed block", "---\ntitle: A\nBody\n"],
    ["a comment", doc("# note\ntitle: A")],
    ["a duplicate key", doc("title: A\ntitle: B")],
    ["a duplicate nested key", doc("requires:\n  plan: a\n  plan: b")],
    ["an unquoted bracket value that is not a list", doc("title: {a: 1}")],
    ["a block scalar", doc("title: |\n  text")],
    ["a tab-indented key", doc("requires:\n\tplan: a")],
    ["nested maps deeper than one level", doc("requires:\n  plan: a\n    deep: b")],
    ["a broken double quote", doc('title: "unterminated')],
    ["an unterminated list", doc("roles: [a, b")],
    ["a list with an empty item", doc("roles: [a, , b]")],
    ["a line that is not key: value", doc("just words")],
  ])("rejects %s", (_name, source) => {
    expect(() => parseFrontmatter(source, "x.md")).toThrow(FrontmatterError);
  });
});

const valid = {
  title: "A title",
  slug: "a-title",
  category: "Getting Started",
  summary: "A summary.",
  order: 10,
};

describe("validateFrontmatter", () => {
  it("fills defaults for optional fields", () => {
    const result = validateFrontmatter(valid, "a.md");
    expect(result).toEqual({
      ok: true,
      value: {
        ...valid,
        visibility: "public",
        status: "published",
        roles: [],
        audience: [],
        sensitivity: "public",
        citationLabel: null,
        requires: {},
        lastVerified: null,
        related: [],
        contexts: [],
      },
    });
  });

  it("accepts the full optional set", () => {
    const result = validateFrontmatter(
      {
        ...valid,
        visibility: "signed_in",
        status: "draft",
        roles: ["owner", "front_desk"],
        audience: ["studio_staff", "organizer"],
        sensitivity: "internal",
        citationLabel: "Client portal invites",
        requires: { plan: "growth", flags: ["MY_FLAG"] },
        lastVerified: "2026-11-21",
        related: ["other-article"],
        contexts: [],
      },
      "a.md",
    );
    expect(result.ok).toBe(true);
  });

  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a missing title", { ...valid, title: undefined }, /"title" is required/],
    ["a blank summary", { ...valid, summary: "  " }, /"summary" is required/],
    ["padded text", { ...valid, title: " padded" }, /whitespace/],
    ["an uppercase slug", { ...valid, slug: "Bad_Slug" }, /"slug" must be lowercase/],
    ["a missing order", { ...valid, order: undefined }, /"order" is required/],
    ["a fractional order", { ...valid, order: 1.5 }, /"order"/],
    ["an unknown key", { ...valid, extra: "x" }, /unknown frontmatter key "extra"/],
    ["an unknown visibility", { ...valid, visibility: "private" }, /"visibility"/],
    ["an unknown status", { ...valid, status: "archived" }, /"status"/],
    ["an unknown audience", { ...valid, audience: ["everyone"] }, /unknown audience/],
    ["duplicate audiences", { ...valid, audience: ["student", "student"] }, /"audience" has duplicates/],
    ["an unknown sensitivity", { ...valid, sensitivity: "secret" }, /"sensitivity"/],
    ["a non-public sensitivity on a public article", { ...valid, sensitivity: "internal" }, /requires "visibility: signed_in"/],
    ["a blank citation label", { ...valid, citationLabel: " " }, /"citationLabel"/],
    ["an unknown role", { ...valid, roles: ["wizard"] }, /unknown role "wizard"/],
    ["duplicate roles", { ...valid, roles: ["owner", "owner"] }, /duplicates/],
    ["a non-map requires", { ...valid, requires: "growth" }, /"requires" must be a map/],
    ["an unknown requires key", { ...valid, requires: { tier: "x" } }, /unknown "requires" key/],
    ["a lowercase flag", { ...valid, requires: { flags: ["my_flag"] } }, /AN_ENV_FLAG/],
    ["an impossible date", { ...valid, lastVerified: "2026-13-45" }, /YYYY-MM-DD/],
    ["a slashed date", { ...valid, lastVerified: "11/21/2026" }, /YYYY-MM-DD/],
    ["a self reference", { ...valid, related: ["a-title"] }, /itself/],
    ["a non-slug related entry", { ...valid, related: ["Not A Slug"] }, /not a valid slug/],
    ["duplicate related", { ...valid, related: ["x-y", "x-y"] }, /duplicates/],
    ["filled contexts", { ...valid, contexts: ["app.clients"] }, /reserved for KB-4/],
  ];

  it.each(bad)("rejects %s", (_name, raw, message) => {
    const result = validateFrontmatter(raw, "a.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toMatch(message);
  });
});

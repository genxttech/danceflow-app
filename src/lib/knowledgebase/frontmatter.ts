/**
 * KB-2B: a deliberately small frontmatter reader. No dependency, and a strict subset so mistakes fail loudly.
 *
 * Accepted:
 *   ---
 *   key: plain text            (a plain scalar; numbers become numbers when the whole value is digits)
 *   key: "double quoted"       (JSON string escapes)
 *   key: 'single ''quoted'''
 *   key: [a, b, "c, d"]        (inline list of scalars; [] is an empty list)
 *   key:                       (a map: indented "name: value" lines below, one level only)
 *     name: value
 *   ---
 *   Markdown body
 *
 * Not accepted: comments, multi-line scalars, anchors, nested maps, duplicate keys. Each throws.
 */

export type FrontmatterValue = string | number | string[] | { [key: string]: string | number | string[] };

export class FrontmatterError extends Error {}

function parseQuoted(text: string, where: string): string {
  if (text.startsWith('"')) {
    try {
      const value = JSON.parse(text);
      if (typeof value === "string") return value;
    } catch {
      /* fall through */
    }
    throw new FrontmatterError(`${where}: invalid double-quoted string ${text}`);
  }
  if (text.length >= 2 && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  throw new FrontmatterError(`${where}: invalid single-quoted string ${text}`);
}

function parseScalar(text: string, where: string): string | number {
  const value = text.trim();
  if (value.startsWith('"') || value.startsWith("'")) return parseQuoted(value, where);
  if (/^\d+$/.test(value)) return Number(value);
  if (value.startsWith("[") || value.startsWith("{") || value.startsWith("|") || value.startsWith(">") || value.startsWith("&") || value.startsWith("*") || value.startsWith("#")) {
    throw new FrontmatterError(`${where}: unsupported value syntax ${value}`);
  }
  return value;
}

function splitInlineList(inner: string, where: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"') {
        current += inner[i + 1] ?? "";
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      items.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (quote) throw new FrontmatterError(`${where}: unterminated quote in list`);
  items.push(current);
  return items.map((item) => item.trim()).filter((item, index, all) => !(item === "" && all.length === 1));
}

function parseValue(text: string, where: string): string | number | string[] {
  const value = text.trim();
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new FrontmatterError(`${where}: unterminated list`);
    return splitInlineList(value.slice(1, -1), where).map((item) => {
      const scalar = parseScalar(item, where);
      if (typeof scalar !== "string") throw new FrontmatterError(`${where}: list items must be text, got ${item}`);
      if (scalar === "") throw new FrontmatterError(`${where}: empty list item`);
      return scalar;
    });
  }
  return parseScalar(value, where);
}

export function parseFrontmatter(
  source: string,
  where: string,
): { data: Record<string, FrontmatterValue>; body: string } {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) throw new FrontmatterError(`${where}: file must start with a "---" frontmatter block`);
  const end = text.indexOf("\n---\n", 3);
  const closesAtEof = end === -1 && text.endsWith("\n---");
  if (end === -1 && !closesAtEof) throw new FrontmatterError(`${where}: frontmatter block is not closed with "---"`);

  const head = text.slice(4, end === -1 ? text.length - 4 : end);
  const body = end === -1 ? "" : text.slice(end + 5);

  const data: Record<string, FrontmatterValue> = {};
  let openMap: { [key: string]: string | number | string[] } | null = null;

  head.split("\n").forEach((line, index) => {
    const lineWhere = `${where} (frontmatter line ${index + 2})`;
    if (line.trim() === "") return;
    if (line.trimStart().startsWith("#")) throw new FrontmatterError(`${lineWhere}: comments are not supported`);

    const indented = /^[ \t]/.test(line);
    const match = /^([A-Za-z][A-Za-z0-9]*):(?:[ \t]+(.*))?$/.exec(line.trim());
    if (!match) throw new FrontmatterError(`${lineWhere}: expected "key: value", got "${line}"`);
    const [, key, rest = ""] = match;

    if (indented) {
      if (!openMap) throw new FrontmatterError(`${lineWhere}: unexpected indentation`);
      if (line.startsWith("\t") || !/^ {2}\S/.test(line)) throw new FrontmatterError(`${lineWhere}: indent nested keys with exactly two spaces`);
      if (key in openMap) throw new FrontmatterError(`${lineWhere}: duplicate key "${key}"`);
      openMap[key] = parseValue(rest, lineWhere);
      return;
    }

    openMap = null;
    if (key in data) throw new FrontmatterError(`${lineWhere}: duplicate key "${key}"`);
    if (rest.trim() === "") {
      const map: { [key: string]: string | number | string[] } = {};
      data[key] = map;
      openMap = map;
    } else {
      data[key] = parseValue(rest, lineWhere);
    }
  });

  return { data, body };
}

/** Writes a value the way `parseFrontmatter` reads it back. Used by the one-time migration and tests. */
export function formatScalar(value: string | number): string {
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

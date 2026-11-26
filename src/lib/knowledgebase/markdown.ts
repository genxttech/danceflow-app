/**
 * KB-2B: the knowledgebase article Markdown subset, parsed to a small block tree.
 *
 * Pure and dependency-free. Rendering lives in `src/components/knowledgebase/ArticleBody.tsx`; nothing here
 * produces HTML, so article text can never inject markup.
 *
 * Supported blocks (one per line unless noted, exactly like the original renderer: a line is a paragraph):
 *   ## / ### / ####   headings (a single "# " is shown as a second-level heading; the page title is the only h1)
 *   - item            bulleted list (consecutive lines)
 *   1. item           numbered list (consecutive lines; the first number sets the start)
 *   | a | b |         table (header row, a |---|---| separator row, then body rows)
 *   > **Note:** text  callout; first word picks the style: Note, Tip, Prerequisite, Warning
 *   ![alt](/path.png) image on its own line (local path or https)
 * Inline: **bold**, `code`, [text](/internal-path | https://... | mailto:...). Anything else is plain text.
 * Links with any other scheme (javascript:, data:, protocol-relative //) are rendered as their literal text.
 */

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string; kind: "internal" | "file" | "external" };

export type CalloutVariant = "note" | "tip" | "prerequisite" | "warning";

export type Block =
  | { type: "heading"; level: 2 | 3 | 4; id: string; inlines: InlineNode[] }
  | { type: "paragraph"; inlines: InlineNode[] }
  | { type: "ul"; items: InlineNode[][] }
  | { type: "ol"; start: number; items: InlineNode[][] }
  | { type: "table"; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: "callout"; variant: CalloutVariant; lines: InlineNode[][] }
  | { type: "image"; alt: string; src: string };

export function classifyHref(href: string): "internal" | "file" | "external" | null {
  if (/^\/(?!\/)[^\s]*$/.test(href)) {
    return /\.(pdf|zip|csv|xlsx?|docx?)(?:[?#].*)?$/i.test(href) ? "file" : "internal";
  }
  if (/^https:\/\/[^\s/]+[^\s]*$/.test(href) || /^mailto:[^\s@]+@[^\s@]+$/.test(href)) return "external";
  return null;
}

const INLINE = /(\*\*.+?\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const push = (node: InlineNode) => {
    const last = nodes[nodes.length - 1];
    if (node.type === "text" && last?.type === "text") last.text += node.text;
    else nodes.push(node);
  };

  for (const part of text.split(INLINE)) {
    if (part === "") continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      push({ type: "strong", text: part.slice(2, -2) });
      continue;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      push({ type: "code", text: part.slice(1, -1) });
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const kind = classifyHref(link[2]);
      if (kind) push({ type: "link", text: link[1], href: link[2], kind });
      else push({ type: "text", text: part });
      continue;
    }
    push({ type: "text", text: part });
  }
  return nodes;
}

export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[`*]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

const SEPARATOR_ROW = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;

const CALLOUT_LABELS: Record<string, CalloutVariant> = {
  note: "note",
  tip: "tip",
  prerequisite: "prerequisite",
  prerequisites: "prerequisite",
  warning: "warning",
  important: "warning",
};

export function parseArticleMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").trim().split("\n");
  const blocks: Block[] = [];
  const usedIds = new Map<string, number>();

  const uniqueId = (text: string) => {
    const base = slugifyHeading(text);
    const seen = usedIds.get(base) ?? 0;
    usedIds.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "") continue;

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const hashes = heading[1].length;
      const level = (hashes <= 2 ? 2 : hashes) as 2 | 3 | 4;
      blocks.push({ type: "heading", level, id: uniqueId(heading[2]), inlines: parseInline(heading[2]) });
      continue;
    }

    if (/^[-*] /.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^[-*] /.test(lines[i].trim())) {
        items.push(parseInline(lines[i].trim().slice(2).trim()));
        i += 1;
      }
      i -= 1;
      blocks.push({ type: "ul", items });
      continue;
    }

    const numbered = /^(\d+)\.\s+/.exec(line);
    if (numbered) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(parseInline(lines[i].trim().replace(/^\d+\.\s+/, "")));
        i += 1;
      }
      i -= 1;
      blocks.push({ type: "ol", start: Number(numbered[1]), items });
      continue;
    }

    if (line.startsWith("|") && i + 1 < lines.length && SEPARATOR_ROW.test(lines[i + 1].trim())) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      i -= 1;
      blocks.push({
        type: "table",
        header: header.map(parseInline),
        rows: rows.map((row) => header.map((_, col) => parseInline(row[col] ?? ""))),
      });
      continue;
    }

    if (line.startsWith("> ") || line === ">") {
      const quoted: string[] = [];
      while (i < lines.length && (lines[i].trim().startsWith("> ") || lines[i].trim() === ">")) {
        quoted.push(lines[i].trim().slice(1).trim());
        i += 1;
      }
      i -= 1;
      const label = /^\*\*([A-Za-z]+):?\*\*/.exec(quoted[0] ?? "");
      const variant = (label && CALLOUT_LABELS[label[1].toLowerCase()]) || "note";
      blocks.push({ type: "callout", variant, lines: quoted.filter(Boolean).map(parseInline) });
      continue;
    }

    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line);
    if (image && classifyHref(image[2]) && classifyHref(image[2]) !== "file") {
      blocks.push({ type: "image", alt: image[1], src: image[2] });
      continue;
    }

    blocks.push({ type: "paragraph", inlines: parseInline(line) });
  }

  return blocks;
}

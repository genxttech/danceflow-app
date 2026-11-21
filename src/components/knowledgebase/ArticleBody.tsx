import type { ReactNode } from "react";
import Link from "next/link";
import {
  parseArticleMarkdown,
  type Block,
  type CalloutVariant,
  type InlineNode,
} from "@/lib/knowledgebase/markdown";

/**
 * KB-2B: the shared knowledgebase article renderer (public article page now; the in-app Help panel and
 * ARIA reuse it later). Element-based only: no dangerouslySetInnerHTML, so article text cannot inject markup.
 */

const LINK_CLASS = "font-medium text-[var(--brand-primary)] underline underline-offset-2 hover:opacity-90";

function renderInlines(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "strong":
        return (
          <strong key={index} className="font-semibold text-slate-950">
            {node.text}
          </strong>
        );
      case "code":
        return (
          <code key={index} className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.9em] text-slate-900">
            {node.text}
          </code>
        );
      case "link":
        if (node.kind === "internal") {
          return (
            <Link key={index} href={node.href} className={LINK_CLASS}>
              {node.text}
            </Link>
          );
        }
        return (
          <a
            key={index}
            href={node.href}
            className={LINK_CLASS}
            {...(node.kind === "external" ? { rel: "noopener noreferrer" } : {})}
          >
            {node.text}
          </a>
        );
      default:
        return node.text;
    }
  });
}

const CALLOUT_STYLES: Record<CalloutVariant, { box: string; label: string }> = {
  note: { box: "border-slate-300 bg-slate-50", label: "Note" },
  tip: { box: "border-emerald-300 bg-emerald-50", label: "Tip" },
  prerequisite: { box: "border-sky-300 bg-sky-50", label: "Before you start" },
  warning: { box: "border-amber-400 bg-amber-50", label: "Warning" },
};

const HEADING_CLASS: Record<2 | 3 | 4, string> = {
  2: "mt-9 scroll-mt-24 text-2xl font-semibold tracking-tight text-slate-950",
  3: "mt-7 scroll-mt-24 text-xl font-semibold tracking-tight text-slate-950",
  4: "mt-6 scroll-mt-24 text-lg font-semibold text-slate-950",
};

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.type) {
    case "heading": {
      const Tag = `h${block.level}` as "h2" | "h3" | "h4";
      return (
        <Tag key={index} id={block.id} className={HEADING_CLASS[block.level]}>
          {renderInlines(block.inlines)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={index} className="my-4 text-base leading-8 text-slate-700">
          {renderInlines(block.inlines)}
        </p>
      );
    case "ul":
      return (
        <ul key={index} className="my-5 list-disc space-y-2 pl-6 text-slate-700">
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlines(item)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={index} start={block.start} className="my-5 list-decimal space-y-2 pl-6 text-slate-700">
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlines(item)}</li>
          ))}
        </ol>
      );
    case "table":
      return (
        <div key={index} className="my-6 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm text-slate-700">
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th
                    key={cellIndex}
                    scope="col"
                    className="border-b-2 border-slate-300 px-3 py-2 font-semibold text-slate-950"
                  >
                    {renderInlines(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-slate-200 align-top">
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="px-3 py-2">
                      {renderInlines(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "callout": {
      const style = CALLOUT_STYLES[block.variant];
      return (
        <aside
          key={index}
          role="note"
          aria-label={style.label}
          data-callout={block.variant}
          className={`my-6 rounded-2xl border-l-4 p-4 text-sm leading-7 text-slate-800 ${style.box}`}
        >
          {block.lines.map((line, lineIndex) => (
            <p key={lineIndex} className={lineIndex === 0 ? "" : "mt-2"}>
              {renderInlines(line)}
            </p>
          ))}
        </aside>
      );
    }
    case "image":
      return (
        // eslint-disable-next-line @next/next/no-img-element -- article images are author-supplied static files of unknown size
        <img key={index} src={block.src} alt={block.alt} loading="lazy" className="my-6 h-auto max-w-full rounded-2xl border border-slate-200" />
      );
  }
}

export function renderArticleBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map(renderBlock);
}

export default function ArticleBody({ markdown }: { markdown: string }) {
  return <>{renderArticleBlocks(parseArticleMarkdown(markdown))}</>;
}

// Screen-reader audit of the accessibility trees saved by run.mjs (the *.xml next to the screenshots).
// TalkBack reads this same tree: it merges a control's descendants into one spoken label, so a clickable
// node with no text or content-desc anywhere inside it is announced as just "button" or not focusable.
// Usage: node a11y-audit.mjs <out-dir>   (writes a11y-report.md and a11y-report.json, exit 1 on a failure)
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MIN_DP = 44; // Android guidance is 48dp; allow a little for rounding and nested hit slop

export function parseTree(xml) {
  const root = { children: [] };
  const stack = [root];
  for (const m of xml.matchAll(/<node\b([^>]*?)(\/?)>|<\/node>/g)) {
    if (m[0] === "</node>") { stack.pop(); continue; }
    const attrs = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#10;/g, " ")]));
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds || "");
    const node = { ...attrs, w: b ? +b[3] - +b[1] : 0, h: b ? +b[4] - +b[2] : 0, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!m[2]) stack.push(node);
  }
  return root;
}

const own = (n) => [n.text, n["content-desc"]].map((v) => (v || "").trim()).filter(Boolean).join(" ");
// TalkBack speaks a node's own content-desc and ignores its children; otherwise it merges descendant text.
const label = (n) => ((n["content-desc"] || "").trim() ? n["content-desc"].trim() : [(n.text || "").trim(), ...n.children.map(label)].filter(Boolean).join(" ").trim());
const walk = (n, f) => { f(n); n.children.forEach((c) => walk(c, f)); };

export function auditTree(xml, pxPerDp) {
  const tree = parseTree(xml);
  const unlabelled = [], nested = [], small = [], order = [];
  // uiautomator also lists views hidden from screen readers (importantForAccessibility=no). An unnamed control sitting inside a
  // named interactive ancestor is reported as "nested" (needs a TalkBack gesture check), not as a failure.
  const visit = (n, insideNamed) => {
    if (n.class) {
      const interactive = n.clickable === "true" || n.checkable === "true";
      const l = label(n);
      if (interactive && !l) (insideNamed ? nested : unlabelled).push(`${n.class} ${n["resource-id"] || ""} bounds ${n.bounds}`.trim());
      insideNamed = insideNamed || (interactive && Boolean(l));
    }
    n.children.forEach((c) => visit(c, insideNamed));
  };
  visit(tree, false);
  walk(tree, (n) => {
    if (!n.class) return;
    const interactive = n.clickable === "true" || n.checkable === "true";
    const l = label(n);
    if (interactive && l && (n.w / pxPerDp < MIN_DP || n.h / pxPerDp < MIN_DP) && n.w > 0)
      small.push(`"${l.slice(0, 40)}" is ${Math.round(n.w / pxPerDp)}x${Math.round(n.h / pxPerDp)}dp`);
    const t = own(n);
    if (t && (n.children.length === 0 || n.clickable === "true")) order.push(interactive ? `[${t}]` : t);
  });
  const stutter = order.filter((t, i) => i > 0 && t === order[i - 1]);
  return { unlabelled, nested, small, stutter, order };
}

if (process.argv[1] && process.argv[1].endsWith("a11y-audit.mjs")) {
  const dir = process.argv[2];
  if (!dir || !existsSync(dir)) { console.error("usage: node a11y-audit.mjs <out-dir>"); process.exit(2); }
  const dpi = existsSync(join(dir, "density.txt")) ? +readFileSync(join(dir, "density.txt"), "utf8") : 420;
  const pxPerDp = dpi / 160;
  const results = {};
  let md = `# Screen-reader tree audit\n\nDensity ${dpi} (${pxPerDp} px per dp). Unlabelled = a clickable node with no text or content-desc inside it (TalkBack merges descendants into one label). Small = touch target under ${MIN_DP}dp.\n\n| Screen | Unlabelled controls | Nested unnamed (inside a named control) | Small targets | Repeated labels |
|---|---|---|---|---|
`;
  let fail = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".xml")).sort()) {
    const r = auditTree(readFileSync(join(dir, f), "utf8"), pxPerDp);
    results[f] = r;
    fail += r.unlabelled.length;
    md += `| ${f.replace(".xml", "")} | ${r.unlabelled.length} | ${r.nested.length} | ${r.small.length} | ${r.stutter.length} |\n`;
  }
  for (const [f, r] of Object.entries(results)) {
    if (!r.unlabelled.length && !r.small.length) continue;
    md += `\n## ${f.replace(".xml", "")}\n`;
    r.unlabelled.forEach((u) => (md += `- UNLABELLED: ${u}\n`));
    r.small.forEach((u) => (md += `- small: ${u}\n`));
  }
  md += `\n## Reading order (signed-out screen, then 1.0 light)\n`;
  for (const f of ["signin-screen.xml", "settings-1.0-light.xml", "wallet-1.0-light.xml", "payment-requests-1.0-light.xml"]) if (results[f]) md += `\n**${f.replace(".xml", "")}**: ${results[f].order.join(" > ")}\n`;
  writeFileSync(join(dir, "a11y-report.md"), md);
  writeFileSync(join(dir, "a11y-report.json"), JSON.stringify(results, null, 2));
  console.log(md.split("\n").slice(0, 40).join("\n"));
  process.exit(fail ? 1 : 0);
}

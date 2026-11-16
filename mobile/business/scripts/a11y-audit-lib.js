/*
  Screen-reader audit of the accessibility trees saved by the device smoke (`node scripts/device-smoke.js --a11y`, one `.xml` per
  screen). Ported from the Student app's a11y-audit.mjs (same rules, so the two reports read alike). TalkBack reads this tree: it
  speaks a node's own content-desc and ignores its children, and otherwise merges the descendants' text into one label, so a
  clickable node with no text or content-desc anywhere inside it is announced as just "button" (or cannot be focused).
  Pure: no file system and no adb, unit-tested in src/__tests__/a11yTreeAudit.test.ts.
*/

// Android guidance is 48dp; 44 allows a little for rounding and nested hit slop.
const MIN_DP = 44;

function parseTree(xml) {
  const root = { children: [] };
  const stack = [root];
  for (const m of xml.matchAll(/<node\b([^>]*?)(\/?)>|<\/node>/g)) {
    if (m[0] === "</node>") {
      stack.pop();
      continue;
    }
    const attrs = Object.fromEntries(
      [...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")]),
    );
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds || "");
    const node = { ...attrs, left: b ? +b[1] : 0, top: b ? +b[2] : 0, w: b ? +b[3] - +b[1] : 0, h: b ? +b[4] - +b[2] : 0, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!m[2]) stack.push(node);
  }
  return root;
}

const own = (n) => [n.text, n["content-desc"]].map((v) => (v || "").trim()).filter(Boolean).join(" ");
// What TalkBack says for a node: its own content-desc if it has one (children ignored), else its text plus its children's labels.
const label = (n) => ((n["content-desc"] || "").trim() ? n["content-desc"].trim() : [(n.text || "").trim(), ...n.children.map(label)].filter(Boolean).join(" ").trim());
const walk = (n, f) => {
  f(n);
  n.children.forEach((c) => walk(c, f));
};

/**
 * `pxPerDp`: density / 160. `unlabelled` fails the audit; `small` and `stutter` are reported. `order` is the reading order (interactive items in [brackets]).
 * A target is judged unless it is cut off at the bottom of the screen (`screenHeight`, when known): a partly scrolled-out row is not an undersized control.
 */
function auditTree(xml, pxPerDp, screenHeight) {
  const tree = parseTree(xml);
  const unlabelled = [];
  const small = [];
  const order = [];
  walk(tree, (n) => {
    if (!n.class) return;
    const interactive = n.clickable === "true" || n.checkable === "true";
    const l = label(n);
    if (interactive && !l) unlabelled.push(`${n.class} ${n["resource-id"] || ""} bounds ${n.bounds}`.trim());
    const cutOff = screenHeight ? n.top + n.h >= screenHeight - 2 : false;
    if (interactive && l && !cutOff && n.w > 0 && (n.w / pxPerDp < MIN_DP || n.h / pxPerDp < MIN_DP)) {
      small.push(`"${l.slice(0, 40)}" is ${Math.round(n.w / pxPerDp)}x${Math.round(n.h / pxPerDp)}dp`);
    }
    const t = own(n);
    if (t && (n.children.length === 0 || n.clickable === "true")) order.push(interactive ? `[${t}]` : t);
  });
  const stutter = order.filter((t, i) => i > 0 && t === order[i - 1]);
  return { unlabelled, small, stutter, order };
}

/** The markdown report for a set of screens: `results` is { name: auditTree(...) }. */
function report(results, { density, pxPerDp }) {
  let md = `# Business screen-reader tree audit\n\nDensity ${density} (${pxPerDp} px per dp). Unlabelled = a clickable node with no text or content-desc inside it (TalkBack merges descendants into one label). Small = a control under ${MIN_DP}dp. Stutter = the same words twice in a row in the reading order.\n\n| Screen | Unlabelled | Small | Stutter |\n| --- | --- | --- | --- |\n`;
  for (const [name, r] of Object.entries(results)) md += `| ${name} | ${r.unlabelled.length} | ${r.small.length} | ${r.stutter.length} |\n`;
  for (const [name, r] of Object.entries(results)) {
    if (!r.unlabelled.length && !r.small.length && !r.stutter.length) continue;
    md += `\n## ${name}\n`;
    r.unlabelled.forEach((u) => (md += `- UNLABELLED: ${u}\n`));
    r.small.forEach((u) => (md += `- small: ${u}\n`));
    r.stutter.forEach((u) => (md += `- stutter: ${u}\n`));
  }
  md += `\n## Reading order\n`;
  for (const [name, r] of Object.entries(results)) md += `\n**${name}**: ${r.order.join(" > ")}\n`;
  return md;
}

module.exports = { MIN_DP, parseTree, auditTree, report };

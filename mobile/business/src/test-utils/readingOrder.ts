/*
  What a screen reader would say, in order, from the rendered tree: a node with an accessibilityLabel is spoken as that label and
  its children are skipped when it is a control or an accessible group (TalkBack and VoiceOver do the same); a Text is its string content; hidden subtrees are skipped.
  Interactive items (a button, radio, switch, tab, or anything with onPress) come out in [brackets], like the device audit's
  reading order (scripts/a11y-audit-lib.js), so a jest guard and the on-device report read alike.
*/
/** The shape of screen.toJSON() (react-test-renderer ships no types here). */
export type RenderedNode = { type: string; props?: Record<string, unknown>; children?: Rendered[] | null };
type Rendered = RenderedNode | string;
type Json = Rendered;

const INTERACTIVE = new Set(["button", "radio", "switch", "tab", "link", "checkbox"]);

function textOf(node: Json): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join("");
}

export function spokenOrder(root: RenderedNode | RenderedNode[] | null): string[] {
  const out: string[] = [];
  const visit = (node: Json) => {
    if (typeof node === "string") return;
    const p = (node.props ?? {}) as Record<string, unknown>;
    if (p.accessibilityElementsHidden === true || p.importantForAccessibility === "no-hide-descendants" || p["aria-hidden"] === true) return;
    const label = typeof p.accessibilityLabel === "string" ? p.accessibilityLabel.trim() : "";
    const interactive = INTERACTIVE.has(String(p.accessibilityRole)) || typeof p.onPress === "function" || typeof p.onClick === "function";
    if (label) {
      out.push(interactive ? `[${label}]` : label);
      // a labelled control or an accessible group is spoken as one item; a plain container that only names a group (a radio group) still has its members read after it
      if (interactive || p.accessible === true || node.type === "Text") return;
      (node.children ?? []).forEach(visit);
      return;
    }
    if (node.type === "Text") {
      const t = textOf(node).trim();
      if (t) out.push(interactive ? `[${t}]` : t);
      return;
    }
    (node.children ?? []).forEach(visit);
  };
  (Array.isArray(root) ? root : root ? [root] : []).forEach(visit);
  return out;
}

/** True when `expected` appears in `order` in this relative order (other items may sit between them). */
export function inOrder(order: string[], expected: (string | RegExp)[]): boolean {
  let from = 0;
  for (const want of expected) {
    const i = order.findIndex((item, idx) => idx >= from && (want instanceof RegExp ? want.test(item) : item === want));
    if (i < 0) return false;
    from = i + 1;
  }
  return true;
}

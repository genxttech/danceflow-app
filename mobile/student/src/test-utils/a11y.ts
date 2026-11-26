import { StyleSheet } from "react-native";
/** The parts of a react-test-renderer instance the audit reads. */
export type ReactTestInstance = { type: unknown; props: Record<string, unknown>; children: (ReactTestInstance | string)[] };

/*
  Static accessibility audit of a rendered tree. It checks what can be checked without a device:
  - every interactive element has a role and a name, and a touch target of at least 44 pt (minHeight/height);
  - text can scale to 200%: font scaling is never turned off, text is never truncated (numberOfLines),
    and no container with a fixed height holds text;
  - every text input has a label.
  Rendering at 200% on a device (or the web emulation in the PR) is still needed for the visual result.
*/

export const MIN_TOUCH = 44;

const INTERACTIVE_ROLES = new Set(["button", "radio", "tab", "link", "checkbox", "switch", "menuitem"]);

type Props = Record<string, unknown>;

function isHost(node: ReactTestInstance) {
  return typeof node.type === "string";
}

function flat(style: unknown): Record<string, unknown> {
  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("")
    .trim();
}

function hasTextDescendant(node: ReactTestInstance): boolean {
  return node.children.some((child) => typeof child !== "string" && ((child.type as unknown) === "Text" || hasTextDescendant(child)));
}

function describe(node: ReactTestInstance) {
  const p = node.props as Props;
  return `<${String(node.type)}${p.testID ? ` testID=${String(p.testID)}` : ""}${p.accessibilityLabel ? ` label="${String(p.accessibilityLabel)}"` : ""}> "${textOf(node).slice(0, 40)}"`;
}

export function auditA11y(root: unknown): string[] {
  const problems: string[] = [];
  const visit = (node: ReactTestInstance) => {
    if (isHost(node)) {
      const p = node.props as Props;
      const style = flat(p.style);
      const role = typeof p.accessibilityRole === "string" ? p.accessibilityRole : null;
      const pressable = typeof p.onClick === "function" || typeof p.onResponderRelease === "function";

      if (pressable && node.type === "View") {
        if (!role || !INTERACTIVE_ROLES.has(role)) problems.push(`pressable without an interactive role: ${describe(node)}`);
        const name = (typeof p.accessibilityLabel === "string" && p.accessibilityLabel.trim()) || textOf(node);
        if (!name) problems.push(`pressable without a name: ${describe(node)}`);
        const height = Math.max(Number(style.minHeight ?? 0), Number(style.height ?? 0));
        if (height < MIN_TOUCH) problems.push(`touch target under ${MIN_TOUCH}pt (minHeight ${height}): ${describe(node)}`);
      }

      if (node.type === "Text") {
        if (p.allowFontScaling === false) problems.push(`text with font scaling turned off: ${describe(node)}`);
        if (typeof p.numberOfLines === "number") problems.push(`truncated text (numberOfLines): ${describe(node)}`);
        if (style.height !== undefined) problems.push(`text with a fixed height: ${describe(node)}`);
      }

      if (node.type === "View" && style.height !== undefined && hasTextDescendant(node)) {
        problems.push(`fixed-height container holding text (clips at 200%): ${describe(node)}`);
      }

      if (node.type === "TextInput") {
        if (!(typeof p.accessibilityLabel === "string" && p.accessibilityLabel.trim())) problems.push(`text input without a label: ${describe(node)}`);
        if (p.allowFontScaling === false) problems.push(`text input with font scaling turned off: ${describe(node)}`);
        if (Number(style.minHeight ?? style.height ?? 0) < MIN_TOUCH) problems.push(`text input under ${MIN_TOUCH}pt: ${describe(node)}`);
      }
    }
    for (const child of node.children) if (typeof child !== "string") visit(child);
  };
  visit(root as ReactTestInstance);
  return [...new Set(problems)];
}

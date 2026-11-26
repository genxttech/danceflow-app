import type { AssistantConfig, AssistantLinkRequest, ResolvedLink } from "./types";
import { isEntityId } from "./screenContext";

/*
  Deep-link whitelist. A responder names a target id + params; only targets in the assistant's config resolve, and only when every
  declared param has the right shape. The href is built from the config template, never from responder text. Anything else is rejected.
*/

const PLACEHOLDER = /\[([a-zA-Z][a-zA-Z0-9]*)\]/g;

export function resolveLink(config: AssistantConfig, link: unknown): ResolvedLink | null {
  if (!link || typeof link !== "object") return null;
  const { target, params, label } = link as Partial<AssistantLinkRequest>;
  if (typeof target !== "string" || typeof label !== "string" || !label.trim()) return null;
  const spec = config.deepLinks.find((d) => d.id === target);
  if (!spec) return null;

  const declared = spec.params ?? {};
  const given = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  // Extra params are refused rather than ignored: a responder naming data a route does not take is a defect worth surfacing.
  for (const key of Object.keys(given)) if (!Object.prototype.hasOwnProperty.call(declared, key)) return null;
  // Every declared param must appear in the template.
  for (const name of Object.keys(declared)) if (!spec.template.includes(`[${name}]`)) return null;

  let ok = true;
  const href = spec.template.replace(PLACEHOLDER, (_, name: string) => {
    const kind = Object.prototype.hasOwnProperty.call(declared, name) ? declared[name] : undefined;
    const value = given[name];
    if (!kind || !isEntityId(kind, value)) {
      ok = false;
      return "";
    }
    return value;
  });
  return ok ? { target: spec.id, href, label: label.trim() } : null;
}

export interface ResolvedReply {
  readonly text: string;
  readonly links: readonly ResolvedLink[];
}

/** Resolves a reply's links; each rejected link's label is appended to the text as plain words so nothing is lost or tappable. */
export function resolveReplyLinks(config: AssistantConfig, text: string, links: readonly unknown[] | undefined): ResolvedReply {
  const resolved: ResolvedLink[] = [];
  const rejected: string[] = [];
  for (const link of links ?? []) {
    const r = resolveLink(config, link);
    if (r) resolved.push(r);
    else {
      const label = link && typeof link === "object" ? (link as { label?: unknown }).label : null;
      if (typeof label === "string" && label.trim()) rejected.push(label.trim());
    }
  }
  return { text: rejected.length ? `${text}\n\n${rejected.join("\n")}` : text, links: resolved };
}

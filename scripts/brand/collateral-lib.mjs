// Pure helpers for the BR-5 collateral builder (no browser, no file writes). Imported by
// build-collateral.mjs and by the collateral test, so URL and QR rules live in one place.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode");

/** Mirrors src/lib/public/attribution.ts: the only keys the website reads. */
export const ALLOWED_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"];
const VALUE_PATTERN = /^[A-Za-z0-9._~-]{1,64}$/;

/** Builds a tagged landing URL from a copy.json `link` block. Throws on any value the site would drop. */
export function buildUrl(meta, link) {
  const params = {
    utm_source: link.source,
    utm_medium: link.medium,
    utm_campaign: meta.campaign,
    utm_content: link.content,
    ...(link.term ? { utm_term: link.term } : {}),
    ...(link.ref ? { ref: link.ref } : {}),
  };
  const url = new URL(meta.baseUrl + link.path);
  for (const [key, value] of Object.entries(params)) {
    if (!ALLOWED_PARAMS.includes(key)) throw new Error(`Unknown attribution key: ${key}`);
    if (!VALUE_PATTERN.test(value)) throw new Error(`Unsafe attribution value for ${key}: ${value}`);
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Short, untagged URL text for printing (never the tagged URL). */
export function displayUrl(meta, link) {
  return meta.displayHost + (link.path === "/" ? "" : link.path);
}

/**
 * Vector QR as an inline SVG. Error correction M, 4-module quiet zone built into the viewBox
 * (so the SVG is the whole light tile), pure black modules on white, no logo.
 */
export function buildQr(url) {
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const quiet = 4;
  const total = n + quiet * 2;
  let path = "";
  for (let y = 0; y < n; y += 1) {
    let x = 0;
    while (x < n) {
      if (!qr.modules.get(x, y)) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < n && qr.modules.get(x + run, y)) run += 1;
      path += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
      x += run;
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  return { svg, modules: n, total, symbolFraction: n / total };
}

/** Minimal template engine: {{x}} (escaped), {{{x}}} (raw), {{#each x}}..{{/each}}, {{#if x}}..{{/if}}. */
const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parse(tpl) {
  const tokens = tpl.split(/(\{\{\{[^}]+\}\}\}|\{\{[^}]+\}\})/);
  const root = { type: "root", children: [] };
  const stack = [root];
  for (const token of tokens) {
    if (!token) continue;
    const top = stack[stack.length - 1];
    if (token.startsWith("{{{")) top.children.push({ type: "raw", path: token.slice(3, -3).trim() });
    else if (token.startsWith("{{#")) {
      const [kind, path] = token.slice(3, -2).trim().split(/\s+/);
      const node = { type: kind, path, children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (token.startsWith("{{/")) stack.pop();
    else if (token.startsWith("{{")) top.children.push({ type: "var", path: token.slice(2, -2).trim() });
    else top.children.push({ type: "text", value: token });
  }
  return root;
}

function lookup(path, scopes) {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    if (path === "this") return scopes[i].__item !== undefined ? scopes[i].__item : scopes[i];
    let value = scopes[i];
    for (const part of path.split(".")) {
      value = value == null ? undefined : value[part];
    }
    if (value !== undefined) return value;
  }
  return undefined;
}

function renderNode(node, scopes) {
  switch (node.type) {
    case "text":
      return node.value;
    case "var": {
      const v = lookup(node.path, scopes);
      return v == null ? "" : escapeHtml(v);
    }
    case "raw": {
      const v = lookup(node.path, scopes);
      return v == null ? "" : String(v);
    }
    case "if": {
      const v = lookup(node.path, scopes);
      const truthy = Array.isArray(v) ? v.length > 0 : Boolean(v);
      return truthy ? node.children.map((c) => renderNode(c, scopes)).join("") : "";
    }
    case "each": {
      const list = lookup(node.path, scopes) ?? [];
      return list.map((item, index) => node.children.map((c) => renderNode(c, [...scopes, { index: index + 1, ...(typeof item === "object" ? item : {}), __item: item }])).join("")).join("");
    }
    default:
      return node.children.map((c) => renderNode(c, scopes)).join("");
  }
}

export function renderTemplate(tpl, data) {
  return renderNode(parse(tpl), [data]);
}

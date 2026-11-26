#!/usr/bin/env node
// Lists every tracked reference to the repository's owner, and rewrites the functional "owner/name" pins when the
// repository is transferred. It only reads unless --apply is given.
//
// Usage (from anywhere inside the checkout):
//   node scripts/ops/repo-owner-refs.mjs --from <owner/name>
//   node scripts/ops/repo-owner-refs.mjs --from <owner/name> --to <new-owner/name> --apply
//
// --apply rewrites only "owner/name" in functional files. It never touches documents, evidence records, or a bare
// owner login (code owners, reviewers, account names), which stay valid or need a decision by hand.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SLUG = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const CODE_UNDER_DOCS = /\.(mjs|cjs|js|ts|tsx|json|sh|yml|yaml|py|ps1)$/;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "pin": code or configuration that behaves differently after a transfer. "document": prose and historical records. */
export function classify(path) {
  if (path.includes("/evidence/") || path.endsWith(".md")) return "document";
  if (path.startsWith("docs/")) return CODE_UNDER_DOCS.test(path) ? "pin" : "document";
  return "pin";
}

/** Matches "owner/name" exactly, so a longer repository name is left alone. A ".git" suffix still matches. */
export const slugPattern = (slug) => new RegExp(`(?<![A-Za-z0-9-])${escape(slug)}(?![A-Za-z0-9_-])`, "g");

export function scan(root, from) {
  const owner = from.split("/")[0];
  const listed = (() => {
    try {
      return execFileSync("git", ["grep", "-z", "-I", "-l", "-F", "-e", owner], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      if (error.status === 1) return ""; // no match
      throw error;
    }
  })();
  const slug = slugPattern(from);
  const login = new RegExp(`(?<![A-Za-z0-9-])${escape(owner)}(?![A-Za-z0-9-])`);
  // A constant holding the bare owner, such as OWNER = "name": it silently keeps pointing at the old owner.
  const constant = new RegExp(`\\b[A-Z_]*OWNER[A-Z_]*\\b\\s*[:=]\\s*["'\`]${escape(owner)}["'\`]`);
  const result = { pins: [], documents: [], constants: [], logins: [] };
  for (const path of listed.split("\0").filter(Boolean).sort()) {
    const kind = classify(path);
    readFileSync(join(root, path), "utf8").split("\n").forEach((text, index) => {
      const line = index + 1;
      const pinned = (text.match(slug) ?? []).length;
      if (pinned) (kind === "pin" ? result.pins : result.documents).push({ path, line, count: pinned });
      if (kind === "pin" && constant.test(text)) result.constants.push({ path, line });
      else if (login.test(text.replace(slug, ""))) result.logins.push({ path, line, kind });
    });
  }
  return result;
}

export function rewrite(root, from, to) {
  if (!SLUG.test(to)) throw new Error("--to must be owner/name");
  const files = [...new Set(scan(root, from).pins.map((p) => p.path))];
  if (files.length === 0) return [];
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
  if (dirty) throw new Error(`commit or discard these changes first:\n${dirty}`);
  const slug = slugPattern(from);
  for (const path of files) {
    const file = join(root, path);
    writeFileSync(file, readFileSync(file, "utf8").replace(slug, () => to));
  }
  return files;
}

function summarize(rows) {
  const byFile = new Map();
  for (const r of rows) byFile.set(r.path, [...(byFile.get(r.path) ?? []), r.line]);
  return [...byFile].map(([path, lines]) => `  ${path}: line ${lines.join(", ")}`);
}

export function report(from, result) {
  const section = (title, rows) => [`${title} (${rows.length} lines in ${new Set(rows.map((r) => r.path)).size} files)`, ...summarize(rows)];
  const owner = from.split("/")[0];
  return [
    ...section(`PINS: "${from}" in code and configuration, rewritten by --apply`, result.pins),
    ...section(`CONSTANTS: bare "${owner}" assigned to an owner constant, change by hand`, result.constants),
    ...section(`LOGINS: other lines naming "${owner}" in code and configuration, review by hand`, result.logins.filter((r) => r.kind === "pin")),
    ...section(`DOCUMENTS: "${from}" in documents and records, left unchanged`, result.documents),
    ...section(`DOCUMENT LOGINS: other lines naming "${owner}" in documents`, result.logins.filter((r) => r.kind === "document")),
  ].join("\n");
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") args.apply = true;
    else if ((argv[i] === "--from" || argv[i] === "--to") && argv[i + 1] !== undefined) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${argv[i]}`);
  }
  if (!SLUG.test(args.from ?? "")) throw new Error("--from owner/name is required");
  if (args.to && !args.apply) throw new Error("--to has no effect without --apply");
  if (args.apply && !args.to) throw new Error("--apply needs --to owner/name");
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (args.apply) {
    const files = rewrite(root, args.from, args.to);
    console.log([`Rewrote ${args.from} to ${args.to} in ${files.length} files:`, ...files.map((f) => `  ${f}`)].join("\n"));
    console.log("Remaining references:");
  }
  console.log(report(args.from, scan(root, args.from)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`repo-owner-refs: ${error.message}`);
    process.exitCode = 2;
  }
}

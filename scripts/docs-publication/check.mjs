// Documentation publication check. Dependency free: Node and git only.
// Policy and usage: docs/Documentation_Publication_Policy.md.
//
//   node scripts/docs-publication/check.mjs --base <ref> [--head <ref>]   added lines of changed documentation
//   node scripts/docs-publication/check.mjs --all [--head <ref>]          every line of all documentation (audit)
//
// Optional: --repo <dir>, --allowlist <file>.
// DOCS_PUBLICATION_DENYLIST: private names, one per line (or separated by ";"). Never commit the list.
//
// The output gives the kind and location of a finding and never the matched text, because CI logs can be read by others.
// Exit codes: 0 no findings, 1 findings, 2 the check could not run.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|mp4|mov|zip|gz|ttf|otf|woff2?|docx|xlsx|pptx)$/i;

export const isDocumentation = (path) => (path.startsWith("docs/") || /\.(md|mdx)$/i.test(path)) && !BINARY.test(path);

const PATTERNS = [
  ["uuid", /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi],
  // Twilio style: two capital letters and 32 hex characters, or the shortened form written with an ellipsis.
  ["provider-sid", /\b(?:AC|AD|BN|BU|CH|CM|IS|IT|MG|MM|MZ|NO|PN|QE|RA|RD|RN|SK|SM|VA|VE|ZR|ZS)(?:[0-9a-f]{32}\b|[0-9a-f]{6,31}(?=…|\.\.\.))/g],
  // Stripe and hosting identifiers. The tail needs a digit or a capital so that ordinary snake_case names do not match.
  ["provider-id", /\b(?:acct|ch|cus|dpl|evt|in|pi|pm|price|prod|seti|si|sub|txn|whsec)_(?:live_|test_)?(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{10,}\b/g],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ["phone", /(?<![\w.-])(?:\+[1-9]\d{9,14}|\+1[ .-]?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}|\(\d{3}\) ?\d{3}[ .-]?\d{4}|\d{3}[.-]\d{3}[.-]\d{4})(?![\w-])/g],
  ["ein-like", /(?<![\w-])\d{2}-\d{7}(?![\w-])/g],
];

const RESERVED_EMAIL_DOMAIN = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;

/** Values that are synthetic by construction and need no allowlist entry. */
export function isSynthetic(kind, value) {
  if (kind === "uuid") {
    // Placeholder style: each group repeats one digit, apart from the version and variant characters.
    const [a, b, c, d, e] = value.toLowerCase().split("-");
    return [a, b, c.slice(1), d.slice(1), e].every((group) => /^(.)\1*$/.test(group));
  }
  if (kind === "email") return RESERVED_EMAIL_DOMAIN.test(value);
  if (kind === "phone") {
    const digits = value.replace(/\D/g, "");
    return /^1?\d{3}55501\d\d$/.test(digits) || /^1?555\d{7}$/.test(digits);
  }
  if (kind === "ein-like") return value === "00-0000000" || value === "12-3456789";
  return false;
}

const squash = (text) => text.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Each term is compared without case, spacing or punctuation, so a name also matches its slug and file-name forms. */
export function parseDenylist(raw) {
  return String(raw ?? "").split(/[\r\n;]+/).map((t) => squash(t)).filter((t) => t.length >= 4);
}

export function scanLine(line, { allow = new Set(), deny = [] } = {}) {
  const found = [];
  for (const [kind, pattern] of PATTERNS) {
    for (const match of line.matchAll(pattern)) {
      const value = match[0];
      if (!isSynthetic(kind, value) && !allow.has(value.toLowerCase())) found.push(kind);
    }
  }
  if (deny.length) {
    const flat = squash(line);
    deny.forEach((term, i) => { if (flat.includes(term)) found.push(`private-name #${i + 1}`); });
  }
  return found;
}

/** Added lines, with their new line numbers, from `git diff --unified=0` output for one file. */
export function addedLines(diff) {
  const out = [];
  let next = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -\S+ \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { next = Number(hunk[1]); inHunk = true; continue; }
    if (inHunk && line.startsWith("+")) out.push([next++, line.slice(1)]);
  }
  return out;
}

export function loadAllowlist(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed.values) || !parsed.values.every((v) => typeof v === "string")) throw new Error("allowlist: \"values\" must be a list of strings");
  return new Set(parsed.values.map((v) => v.toLowerCase()));
}

export function run({ repo = process.cwd(), base, head = "HEAD", all = false, allowlist = join(HERE, "allowlist.json"), denylist = "" } = {}) {
  if (!all && !base) throw new Error("give --base <ref>, or --all");
  for (const ref of [base, head]) if (ref && ref.startsWith("-")) throw new Error("a ref cannot start with \"-\"");
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "pipe"] });
  const options = { allow: loadAllowlist(allowlist), deny: parseDenylist(denylist) };
  const range = all ? null : `${base}...${head}`;
  const listed = all
    ? git("ls-tree", "-r", "-z", "--name-only", head)
    : git("diff", "--name-only", "-z", "--no-renames", "--diff-filter=AM", range, "--");
  const files = listed.split("\0").filter((p) => p && isDocumentation(p));
  const findings = [];
  files.forEach((path, index) => {
    const nameHits = scanLine(path, options);
    // A file name that itself matches is not printed.
    const shown = nameHits.length ? `<documentation file ${index + 1} of ${files.length}>` : path;
    for (const kind of nameHits) findings.push({ file: shown, line: 0, kind });
    // Added files of an --all audit are read whole; a change is judged on the lines it adds.
    const lines = all
      ? git("show", `${head}:${path}`).split("\n").map((text, i) => [i + 1, text])
      : addedLines(git("diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", range, "--", `:(literal)${path}`));
    for (const [line, text] of lines) {
      for (const kind of scanLine(text, options)) findings.push({ file: shown, line, kind });
    }
  });
  return { files: files.length, findings, denyTerms: options.deny.length };
}

function main(argv) {
  const args = { denylist: process.env.DOCS_PUBLICATION_DENYLIST ?? "" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--all") args.all = true;
    else if (["--base", "--head", "--repo", "--allowlist"].includes(flag) && argv[i + 1]) args[flag.slice(2)] = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${flag}`);
  }
  const result = run(args);
  console.log(`documentation files checked: ${result.files}`);
  console.log(result.denyTerms ? `private name list: ${result.denyTerms} term(s)` : "private name list: not configured, names were not checked");
  for (const f of result.findings) console.log(`${f.file}${f.line ? `:${f.line}` : " (file name)"}  ${f.kind}`);
  console.log(`findings: ${result.findings.length}`);
  if (result.findings.length) console.log("Replace each value with a placeholder. See docs/Documentation_Publication_Policy.md.");
  return result.findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`documentation check could not run: ${String(error.message ?? error).split("\n")[0]}`);
    process.exitCode = 2;
  }
}
